// Compila o addon nativo (Rust, napi-rs) e copia para native/myscreen-native.node.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";

execFileSync("cargo", ["build", "--release", "--manifest-path", "native/Cargo.toml"], { stdio: "inherit" });
const dll = "native/target/release/myscreen_native.dll";
if (!existsSync(dll)) {
  console.error(`não encontrei ${dll}`);
  process.exit(1);
}
copyFileSync(dll, "native/myscreen-native.node");
console.log("native/myscreen-native.node pronto");
