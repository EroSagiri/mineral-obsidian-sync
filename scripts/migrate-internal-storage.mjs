import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { AwsClient } from "aws4fetch";
import { LEGACY_TOMBSTONE_NAMESPACE, VERSION_NAMESPACE, versionSourcePath } from "@mineral/sync-core/storage";
import { TOMBSTONE_NAMESPACE, parseTombstone, tombstoneKey } from "@mineral/sync-core/tombstones";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const asciiJson = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
const decode = value => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return entity[0] === "#" ? String.fromCodePoint(entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))) : named[entity];
});
const field = (xml, name) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? decode(match[1]) : undefined;
};

/** Deterministic destinations make an interrupted migration safely resumable. */
export function migrationTarget(key) {
  if (key.startsWith(LEGACY_TOMBSTONE_NAMESPACE)) return TOMBSTONE_NAMESPACE + key.slice(LEGACY_TOMBSTONE_NAMESPACE.length);
  const reason = key.startsWith(".history/") ? "backup" : key.startsWith(".trash/") ? "delete" : undefined;
  if (!reason) throw new Error("Object is outside the migration scope");
  const prefix = reason === "backup" ? ".history/" : ".trash/";
  const rest = key.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0 || slash === rest.length - 1) throw new Error("Legacy version key is malformed");
  return `${VERSION_NAMESPACE}${rest.slice(0, slash)}-legacy-${reason}/${rest.slice(slash + 1)}`;
}

/** No mutations unless apply is explicit; source retirement is a separate verified pass. */
export async function migrateInternalStorage(config, { apply = false, deleteSource = false, writersPaused = false, backupDir, send } = {}) {
  const endpoint = new URL(config.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid R2 endpoint");
  if (!config.bucket || config.bucket.includes("/") || !config.accessKeyId || !config.secretAccessKey) throw new Error("Incomplete R2 settings");
  if (deleteSource && (!apply || !writersPaused)) throw new Error("Retiring old keys requires --apply --delete-source --writers-paused after every client is upgraded");
  const prefix = (config.remotePrefix ?? "").replace(/^\/+|\/+$/g, "");
  if (prefix.split("/").some(part => part === ".." || part === ".")) throw new Error("Invalid remote prefix");
  const remotePrefix = prefix ? `${prefix}/` : "";
  const base = endpoint.href.replace(/\/+$/, "") + "/" + encodeURIComponent(config.bucket);
  const aws = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto" });
  const request = send ?? ((url, init) => aws.fetch(url, { ...init, signal: AbortSignal.timeout(60000) }));
  const urlFor = key => `${base}/${(remotePrefix + key).split("/").map(encodeURIComponent).join("/")}`;
  const checked = async (url, init, statuses = [200]) => {
    const headers = new Headers(init.headers);
    // A compressed representation may have a weak ETag and decompressed bytes. Read stored bytes.
    if (init.method === "GET" || init.method === "HEAD") headers.set("accept-encoding", "identity");
    const response = await request(url, { ...init, headers });
    if (!statuses.includes(response.status)) throw new Error(`R2 ${init.method} failed (${response.status})`);
    return response;
  };
  const entries = [];
  for (const namespace of [".history/", ".trash/", LEGACY_TOMBSTONE_NAMESPACE]) {
    let token;
    do {
      const url = new URL(base);
      url.searchParams.set("list-type", "2");
      url.searchParams.set("prefix", remotePrefix + namespace);
      if (token) url.searchParams.set("continuation-token", token);
      const xml = await (await checked(url, { method: "GET" })).text();
      if (!xml.includes("</ListBucketResult>")) throw new Error("Invalid R2 listing");
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const remoteKey = field(match[1], "Key");
        const etag = field(match[1], "ETag");
        const acceptedAt = field(match[1], "LastModified");
        if (!remoteKey?.startsWith(remotePrefix + namespace) || !etag || !acceptedAt || !Number.isFinite(Date.parse(acceptedAt))) throw new Error("Incomplete migration listing");
        const key = remoteKey.slice(remotePrefix.length);
        entries.push({ key, etag, acceptedAt, target: migrationTarget(key) });
      }
      token = field(xml, "IsTruncated") === "true" ? field(xml, "NextContinuationToken") : undefined;
      if (field(xml, "IsTruncated") === "true" && !token) throw new Error("Truncated R2 listing without a cursor");
    } while (token);
  }
  const summary = { planned: entries.length, copied: 0, verified: 0, removed: 0 };
  if (!apply && !backupDir) return summary;
  const backup = { createdAt: new Date().toISOString(), bucket: config.bucket, remotePrefix: config.remotePrefix ?? "", sources: [] };
  if (backupDir) await mkdir(backupDir, { recursive: true });
  const verified = [];
  for (const entry of entries) {
    const source = await checked(urlFor(entry.key), { method: "GET", headers: { "if-match": entry.etag } });
    if (source.headers.get("etag") !== entry.etag) throw new Error("Migration source changed after listing");
    let bytes = Buffer.from(await source.arrayBuffer());
    if (backupDir) {
      const file = digest(Buffer.from(entry.key)) + ".bin";
      await writeFile(join(backupDir, file), bytes);
      backup.sources.push({ key: entry.key, body: file, sha256: digest(bytes), headers: Object.fromEntries(source.headers) });
      await writeFile(join(backupDir, "manifest.json"), JSON.stringify(backup, null, 2));
    }
    if (!apply) continue;
    const headers = new Headers();
    for (const [name, value] of source.headers) {
      if (name.startsWith("x-amz-meta-") || ["content-type", "cache-control", "content-disposition", "content-encoding", "content-language", "expires"].includes(name)) headers.set(name, value);
    }
    if (entry.key.startsWith(LEGACY_TOMBSTONE_NAMESPACE)) {
      const record = parseTombstone(bytes);
      if (await tombstoneKey(record.path, record.deletedRemoteETag) !== entry.target) throw new Error("Legacy tombstone key does not match its body");
      // A copy has a new LastModified; retain the original server time used to recognize revivals.
      bytes = Buffer.from(JSON.stringify({ ...record, r2AcceptedAt: record.r2AcceptedAt ?? entry.acceptedAt }));
    } else {
      const originalMetadata = Object.fromEntries([...source.headers].filter(([name]) => name.startsWith("x-amz-meta-")).map(([name, value]) => [name.slice(11), value]));
      if (entry.key.startsWith(".history/")) { delete originalMetadata.sourcekey; delete originalMetadata.createdat; }
      const sourcePath = versionSourcePath(entry.key);
      headers.set("x-amz-meta-sourcekey", encodeURI(sourcePath));
      headers.set("x-amz-meta-createdat", source.headers.get("x-amz-meta-createdat") ?? entry.acceptedAt);
      headers.set("x-amz-meta-reason", entry.key.startsWith(".trash/") ? "delete" : "backup");
      headers.set("x-amz-meta-mineraloriginalmetadata", asciiJson(originalMetadata));
    }
    headers.set("if-none-match", "*");
    const written = await checked(urlFor(entry.target), { method: "PUT", headers, body: bytes }, [200, 412]);
    if (written.status === 200) summary.copied++;
    const target = await checked(urlFor(entry.target), { method: "GET" });
    const targetETag = target.headers.get("etag");
    if (!targetETag || digest(Buffer.from(await target.arrayBuffer())) !== digest(bytes)) throw new Error("Migration target verification failed");
    for (const [name, value] of headers) {
      if (name !== "if-none-match" && target.headers.get(name) !== value) throw new Error("Migration metadata verification failed");
    }
    verified.push({ ...entry, targetETag });
    summary.verified++;
  }
  if (deleteSource) {
    // Preflight the whole batch before removing any old record. Writers must remain stopped.
    for (const entry of verified) {
      await checked(urlFor(entry.key), { method: "HEAD", headers: { "if-match": entry.etag } });
      await checked(urlFor(entry.target), { method: "HEAD", headers: { "if-match": entry.targetETag } });
    }
    for (const entry of verified) {
      await checked(urlFor(entry.key), { method: "DELETE" }, [200, 204]);
      summary.removed++;
    }
  }
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("node scripts/migrate-internal-storage.mjs --settings <plugin-data.json> [--backup <directory>] [--apply] [--delete-source --writers-paused]\nDefault: read-only plan. Upgrade all clients and pause writers before retiring old keys.");
  } else {
    try {
      const settingsAt = args.indexOf("--settings");
      if (settingsAt < 0 || !args[settingsAt + 1]) throw new Error("Provide --settings <plugin-data.json>; credentials are never command-line arguments");
      const config = JSON.parse(await readFile(args[settingsAt + 1], "utf8"));
      const backupAt = args.indexOf("--backup");
      if (backupAt >= 0 && !args[backupAt + 1]) throw new Error("Provide --backup <directory>");
      const summary = await migrateInternalStorage(config, { apply: args.includes("--apply"), deleteSource: args.includes("--delete-source"), writersPaused: args.includes("--writers-paused"), backupDir: backupAt < 0 ? undefined : args[backupAt + 1] });
      console.log(JSON.stringify(summary));
    } catch (error) {
      // Network exceptions can contain signed URLs. Never print their raw text or stack.
      console.error(error instanceof Error && /^(R2 |Invalid |Incomplete |Retiring |Provide |Legacy |Object |Migration |Truncated )/.test(error.message) ? error.message : "Migration failed; no credentials or signed URLs are printed");
      process.exitCode = 1;
    }
  }
}
