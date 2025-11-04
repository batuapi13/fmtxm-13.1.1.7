import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
// Removed nanoid; we will use a stable query param for main.tsx during dev

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  // Resolve __dirname in ESM context
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const serverOptions = {
    middlewareMode: true,
    // Pin HMR to a known client port to avoid default collisions
    hmr: {
      // Align HMR with the Express server port so preview works
      clientPort: parseInt(process.env.PORT || '5000', 10),
      overlay: false,
      // Attach HMR to the existing HTTP server to avoid port conflicts
      server,
    },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    // Use Vite's default logger without exiting the process on errors.
    // This ensures the Express server keeps running even if the client has build/runtime issues.
    customLogger: {
      ...viteLogger,
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    // Skip API routes
    if (url.startsWith('/api/')) {
      return next();
    }

    // Handle Vite HMR ping using HEAD /
    if (req.method === 'HEAD' && url === '/') {
      return res.status(200).end();
    }

    const accept = (req.headers.accept || '').toLowerCase();
    const wantsHtml = req.method === 'GET' && accept.includes('text/html');

    // Vite client performs a ping to '/'; respond with 200 OK for non-HTML pings
    if (url === '/' && !wantsHtml) {
      return res.status(200).type('text/plain').end('ok');
    }

    // Let Vite handle asset and HMR routes
    const isViteAsset = (
      url.startsWith('/@vite') ||
      url.startsWith('/@react-refresh') ||
      url.startsWith('/@fs') ||
      url.startsWith('/@id') ||
      url.startsWith('/node_modules') ||
      /\.(js|mjs|ts|tsx|css|map|json|svg|png|jpg|jpeg|gif|webp|ico)$/i.test(url)
    );

    if (isViteAsset) {
      return next();
    }

    try {
      const clientTemplate = path.resolve(
        __dirname,
        "..",
        "client",
        "index.html",
      );
      const template = await fs.promises.readFile(clientTemplate, "utf-8");
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const distPath = path.resolve(__dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
