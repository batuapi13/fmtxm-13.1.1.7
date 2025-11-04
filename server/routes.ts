import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import snmpRoutes, { snmpPoller } from "./routes/snmp";
import { databaseService } from './services/database-service';
import { snmpTrapManager } from './services/snmp-trap-manager';

export async function registerRoutes(app: Express): Promise<Server> {
  // put application routes here
  // prefix all routes with /api

  // use storage to perform CRUD operations on the storage interface
  // e.g. storage.insertUser(user) or storage.getUserByUsername(username)

  // SNMP routes
  app.use("/api/snmp", snmpRoutes);

  // Initialize DB schema safely (non-destructive changes)
  await databaseService.initializeSchema();

  // Start SNMP Trap Manager to receive traps
  try {
    await snmpTrapManager.start();
  } catch (err) {
    console.error('Failed to start SNMP Trap Manager:', err);
  }

  // Start SNMP Poller and load devices so metrics begin ingesting
  try {
    snmpPoller.start();
  } catch (err) {
    console.error('Failed to start SNMP Poller:', err);
  }

  const httpServer = createServer(app);

  return httpServer;
}
