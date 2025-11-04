import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
// Disabled runtime error overlay plugin due to crash with React hooks
// import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// Resolve directory in a Node ESM-compatible way
const __dirname = path.dirname(new URL(import.meta.url).pathname);

export default defineConfig({
  plugins: [
    react(),
    // runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@assets": path.resolve(__dirname, "attached_assets"),
      // Force single React instance by aliasing to the project root package
      "react": path.resolve(__dirname, "node_modules", "react"),
      "react-dom": path.resolve(__dirname, "node_modules", "react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules", "react", "jsx-runtime.js"),
    },
    // Ensure single React instance to avoid invalid hook call during dev
    dedupe: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
  },
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    hmr: {
      clientPort: 5173,
      overlay: false,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:5000',
        changeOrigin: true,
        secure: false,
      },
    },
    fs: {
      strict: true,
      // Allow workspace root so Vite can serve node_modules/.vite prebundled deps
      allow: [__dirname],
      // Deny sensitive VCS directories only; do not block .vite
      deny: ["**/.git/**"],
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "@tanstack/react-query",
    ],
  },
});
