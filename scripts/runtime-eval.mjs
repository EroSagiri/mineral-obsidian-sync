/** Read or exercise an explicitly selected Obsidian debugging session; expressions are local files. */
import { readFileSync } from 'node:fs';
const [port, source] = process.argv.slice(2);
if (!/^\d+$/.test(port)) throw Error('Expected local debug port');
const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const tab = tabs.find(tab => tab.type === 'page' && /Obsidian/.test(tab.title));
if (!tab) throw Error('No Obsidian page');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Runtime evaluation timed out')), 45000);
    socket.onmessage = event => { const reply = JSON.parse(event.data); if (reply.id !== 1) return; clearTimeout(timer); resolve(reply); };
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: readFileSync(source, 'utf8'), awaitPromise: true, returnByValue: true } }));
  });
  if (result.error || result.result?.exceptionDetails) throw Error(JSON.stringify(result.error ?? result.result.exceptionDetails));
  console.log(JSON.stringify(result.result?.result?.value ?? result.result?.result));
} finally { socket.close(); }
