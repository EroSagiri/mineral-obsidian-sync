import esbuild from "esbuild";

const production = process.argv[2] === "production";

/**
 * Production stub for the development-only modules.
 *
 * `define: { __DEV__: false }` already removes the registration branch, but the imported
 * module bodies would still be bundled. Substituting empty modules keeps the shipped plugin
 * free of the R2 self-test code entirely, so production cannot reach it even by hand.
 */
const stubDevelopmentModules = {
  name: "stub-development-modules",
  setup(build) {
    build.onResolve({ filter: /(^|\/)dev\// }, (args) => ({ path: args.path, namespace: "dev-stub" }));
    build.onLoad({ filter: /.*/, namespace: "dev-stub" }, () => ({
      contents: "export const registerDevelopmentSelfTests = undefined;\n",
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  // Compile-time development flag: `npm run build` folds every `if (__DEV__)` block away.
  define: { __DEV__: JSON.stringify(!production) },
  plugins: production ? [stubDevelopmentModules] : [],
  outfile: "main.js",
});
