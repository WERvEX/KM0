import { createWebBridge } from "./bridge";

const simulated = new URLSearchParams(window.location.search).get("simulated") === "1";
window.km0 = await createWebBridge({ simulated, version: import.meta.env.KM0_VERSION ?? "dev" });
await import("../renderer/src/main");
