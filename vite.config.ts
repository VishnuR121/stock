import react from "@vitejs/plugin-react";
import dotenv from "dotenv";
import { defineConfig } from "vite";

dotenv.config({ path: ".env.local" });
dotenv.config();

export default defineConfig(() => {
  const apiPort = Number(process.env.PORT || 3001);

  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": `http://127.0.0.1:${apiPort}`
      }
    }
  };
});
