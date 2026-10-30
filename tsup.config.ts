import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

export default defineConfig({
  entry: {
    index: "src/index.ts",
    account: "src/account.ts",
    testing: "src/testing.ts",
    cli: "src/cli.ts",
    worker: "src/worker.ts",
    demo: "src/demo.ts",
    client: "src/client.ts",
    react: "src/react/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  onSuccess: "cp src/react/panel.css dist/react.css",
  define: {
    __PACK_VERSION__: JSON.stringify(pkg.version),
  },
});
