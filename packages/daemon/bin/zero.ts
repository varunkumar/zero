import { resolve } from "node:path";
import { startZero } from "../src/main";

const root = resolve(process.argv[2] ?? ".");
const webDist = new URL("../../web/dist", import.meta.url).pathname;
const d = startZero({ root, port: 4820, webDist });
console.log(`zero ready: http://127.0.0.1:${d.port}/?token=${d.token}`);
