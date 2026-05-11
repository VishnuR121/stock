import { createApp } from "./app";
import { getConfig } from "./config";

const config = getConfig();
const app = createApp(config);

app.listen(config.port, "127.0.0.1", () => {
  console.log(`Research copilot API running at http://127.0.0.1:${config.port}`);
});
