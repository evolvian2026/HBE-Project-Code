import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development, /api goes to the backend on your computer; in Docker, nginx forwards it.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, proxy: { "/api": "http://localhost:4000" } },
});
