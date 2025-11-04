import express from 'express';
import { SNMPPoller, SNMPDevice, DeviceResult } from '../services/snmp-poller';
import { databaseService } from '../services/database-service';
import * as snmp from 'net-snmp';
import fs from 'fs';
import path from 'path';
import { loadMibMappings, mapOidToName, stripInstance } from '../services/mib-mapper';

const router = express.Router();
export const snmpPoller = new SNMPPoller();

// Convert version string to SNMP version number
const getSnmpVersion = (version: string): 0 | 1 => {
  switch (version) {
    case 'v1':
      return 0; // Version1
    case 'v2c':
    default:
      return 1; // Version2c
  }
};

// Devices endpoints backed by transmitters (unified source of truth)
// Get all devices derived from transmitters
router.get('/devices', async (_req, res) => {
  try {
    const txs = await databaseService.getAllTransmitters();
  const devices = txs.map((tx) => ({
      id: tx.id,
      host: tx.snmpHost,
      port: tx.snmpPort ?? 161,
      community: tx.snmpCommunity ?? 'public',
      version: (tx.snmpVersion === 0 ? 0 : 1) as 0 | 1,
      oids: Array.isArray(tx.oids) ? tx.oids : [],
      pollInterval: tx.pollInterval ?? 10000,
      isActive: tx.isActive !== false,
      // Extra fields for client convenience
      name: tx.name ?? 'Transmitter',
      label: tx.displayLabel ?? undefined,
      displayOrder: tx.displayOrder ?? 0,
      siteId: tx.siteId,
    }));
    res.json(devices);
  } catch (error) {
    console.error('Failed to get devices from transmitters:', error);
    res.status(500).json({ error: 'Failed to get devices' });
  }
});

// Get a specific device derived from a transmitter
router.get('/devices/:id', async (req, res) => {
  try {
    const tx = await databaseService.getTransmitterById(req.params.id);
    if (!tx) {
      return res.status(404).json({ error: 'Device not found' });
    }
  const device = {
      id: tx.id,
      host: tx.snmpHost,
      port: tx.snmpPort ?? 161,
      community: tx.snmpCommunity ?? 'public',
      version: (tx.snmpVersion === 0 ? 0 : 1) as 0 | 1,
      oids: Array.isArray(tx.oids) ? tx.oids : [],
      pollInterval: tx.pollInterval ?? 10000,
      isActive: tx.isActive !== false,
      name: tx.name ?? 'Transmitter',
      label: tx.displayLabel ?? undefined,
      displayOrder: tx.displayOrder ?? 0,
      siteId: tx.siteId,
    };
    res.json(device);
  } catch (error) {
    console.error('Failed to get device:', error);
    res.status(500).json({ error: 'Failed to get device' });
  }
});

// Add a new device by creating a transmitter
router.post('/devices', async (req, res) => {
  try {
    const d = req.body || {};
    // Expect siteId to tie device to site; default mapping values
    if (!d.siteId) {
      return res.status(400).json({ error: 'siteId is required to create device' });
    }

    const created = await databaseService.upsertTransmitter({
      siteId: d.siteId,
      name: d.name || 'Transmitter',
      displayLabel: d.displayLabel,
      displayOrder: typeof d.displayOrder === 'number' ? d.displayOrder : (typeof d.displayOrder === 'string' ? parseInt(d.displayOrder, 10) || 0 : 0),
      frequency: typeof d.frequency === 'number' ? d.frequency : 0,
      power: typeof d.power === 'number' ? d.power : 0,
      status: d.status || 'unknown',
      snmpHost: d.host || d.snmpHost || '127.0.0.1',
      snmpPort: typeof d.port === 'number' ? d.port : (typeof d.snmpPort === 'number' ? d.snmpPort : 161),
      snmpCommunity: d.community || d.snmpCommunity || 'public',
      snmpVersion: typeof d.version === 'number' ? d.version : (d.version === 'v1' ? 0 : 1),
      oids: Array.isArray(d.oids) ? d.oids : [],
      pollInterval: typeof d.pollInterval === 'number' ? d.pollInterval : 10000,
      isActive: d.isActive !== undefined ? !!d.isActive : true,
    });

    // Ensure poller reflects the new transmitter
    await snmpPoller.loadDevicesFromDatabase();

    const device = {
      id: created.id,
      host: created.snmpHost,
      port: created.snmpPort ?? 161,
      community: created.snmpCommunity ?? 'public',
      version: (created.snmpVersion === 0 ? 0 : 1) as 0 | 1,
      oids: Array.isArray(created.oids) ? created.oids : [],
      pollInterval: created.pollInterval ?? 10000,
      isActive: created.isActive !== false,
      name: created.name ?? 'Transmitter',
      siteId: created.siteId,
    };
    res.status(201).json(device);
  } catch (error) {
    console.error('Failed to add device:', error);
    res.status(500).json({ error: 'Failed to add device' });
  }
});

// Update a device by updating the transmitter
router.put('/devices/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const d = req.body || {};
    const updated = await databaseService.upsertTransmitter({
      id,
      ...(d.siteId ? { siteId: d.siteId } : {}),
      ...(d.name ? { name: d.name } : {}),
      ...(d.displayLabel !== undefined ? { displayLabel: d.displayLabel } : {}),
      ...(d.displayOrder !== undefined ? { displayOrder: typeof d.displayOrder === 'number' ? d.displayOrder : (typeof d.displayOrder === 'string' ? parseInt(d.displayOrder, 10) || 0 : undefined) } : {}),
      ...(d.frequency !== undefined ? { frequency: typeof d.frequency === 'number' ? d.frequency : 0 } : {}),
      ...(d.power !== undefined ? { power: typeof d.power === 'number' ? d.power : 0 } : {}),
      ...(d.status ? { status: d.status } : {}),
      ...(d.host || d.snmpHost ? { snmpHost: d.host || d.snmpHost } : {}),
      ...(d.port !== undefined || d.snmpPort !== undefined ? { snmpPort: typeof d.port === 'number' ? d.port : (typeof d.snmpPort === 'number' ? d.snmpPort : 161) } : {}),
      ...(d.community || d.snmpCommunity ? { snmpCommunity: d.community || d.snmpCommunity } : {}),
      ...(d.version !== undefined ? { snmpVersion: typeof d.version === 'number' ? d.version : (d.version === 'v1' ? 0 : 1) } : {}),
      ...(d.oids !== undefined ? { oids: Array.isArray(d.oids) ? d.oids : [] } : {}),
      ...(d.pollInterval !== undefined ? { pollInterval: typeof d.pollInterval === 'number' ? d.pollInterval : 10000 } : {}),
      ...(d.isActive !== undefined ? { isActive: !!d.isActive } : {}),
    });

    await snmpPoller.loadDevicesFromDatabase();

    const device = {
      id: updated.id,
      host: updated.snmpHost,
      port: updated.snmpPort ?? 161,
      community: updated.snmpCommunity ?? 'public',
      version: (updated.snmpVersion === 0 ? 0 : 1) as 0 | 1,
      oids: Array.isArray(updated.oids) ? updated.oids : [],
      pollInterval: updated.pollInterval ?? 10000,
      isActive: updated.isActive !== false,
      name: updated.name ?? 'Transmitter',
      siteId: updated.siteId,
    };
    res.json(device);
  } catch (error) {
    console.error('Failed to update device:', error);
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// Delete a device by deleting the transmitter
router.delete('/devices/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ok = await databaseService.deleteTransmitter(id);
    if (!ok) {
      return res.status(404).json({ error: 'Device not found' });
    }
    await snmpPoller.loadDevicesFromDatabase();
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete device:', error);
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// Test a device connection
router.post('/test', async (req, res) => {
  try {
    const deviceData = req.body;
    const rawVersion = deviceData.version;
    const versionNum: 0 | 1 = typeof rawVersion === 'number'
      ? (rawVersion === 0 ? 0 : 1)
      : getSnmpVersion(String(rawVersion));

    const device: SNMPDevice = {
      id: deviceData.id || 'test-device',
      host: deviceData.host,
      port: deviceData.port ?? 161,
      community: deviceData.community ?? 'public',
      version: versionNum,
      oids: Array.isArray(deviceData.oids) ? deviceData.oids : [],
      pollInterval: deviceData.pollInterval ?? 10000,
      isActive: true,
    };

    const result = await snmpPoller.testDevice(device);
    res.json(result);
  } catch (error) {
    res.status(500).json({ 
      success: false,
      error: error instanceof Error ? error.message : 'Test failed'
    });
  }
});

// Perform SNMP walk against a target host and build a full OID template
router.post('/walk', async (req, res) => {
  try {
    const host: string = req.body?.host || '192.168.117.22';
    const community: string = req.body?.community || 'public';
    const port: number = parseInt(req.body?.port, 10) || 161;
    const versionStr: string = req.body?.version || 'v2c';
    const version = getSnmpVersion(versionStr) === 0 ? snmp.Version1 : snmp.Version2c;
    const templateNameInput: string | undefined = req.body?.templateName;

    const session = snmp.createSession(host, community, { port, version });

    const walkRoot = req.body?.root || '1.3.6.1';

    let walked: Array<{ oid: string; type: string; value: any }> = [];
    const performWalk = (): Promise<void> => new Promise((resolve, reject) => {
      session.walk(walkRoot, 200, (varbinds) => {
        varbinds.forEach((vb) => {
          // Guard against undefined type; safely index enum by number
          const typeName =
            typeof vb.type === 'number'
              ? ((snmp.ObjectType as unknown as Record<number, string>)[vb.type] ?? 'Unknown')
              : 'Unknown';
          walked.push({ oid: vb.oid, type: typeName, value: vb.value });
        });
      }, (error) => {
        if (error) reject(error); else resolve();
      });
    });

    try {
      await performWalk();
    } catch (walkErr) {
      console.warn('SNMP walk failed, attempting fallback to local snmp_full_walk.txt:', walkErr);
      // Fallback: parse local snmp_full_walk.txt
      const fallbackPath = path.resolve(process.cwd(), 'snmp_full_walk.txt');
      const text = await fs.promises.readFile(fallbackPath, 'utf-8');
      const lines = text.split(/\r?\n/);
      const parsed: Array<{ oid: string; type: string; value: any }> = [];
      const lineRegex = /^(iso\.[\d.]+)\s*=\s*([^:]+):\s*(.*)$/;
      for (const line of lines) {
        const m = lineRegex.exec(line.trim());
        if (!m) continue;
        const isoOid = m[1];
        const type = m[2].trim();
        const valueStr = m[3].trim();
        const oid = isoOid.replace(/^iso\./, '1.');
        parsed.push({ oid, type, value: valueStr });
      }
      walked = parsed;
    } finally {
      session.close();
    }

    // Load MIB mappings from local files for name resolution
    const mibMap = await loadMibMappings();

    // Build template entries: de-duplicate OIDs, map names when possible
    const seen = new Set<string>();
    const oids = walked
      .map((w) => ({ ...w, oidStripped: stripInstance(w.oid) }))
      .filter((w) => {
        if (seen.has(w.oidStripped)) return false;
        seen.add(w.oidStripped);
        return true;
      })
      .map((w, idx) => {
        const name = mapOidToName(w.oidStripped, mibMap) || w.oidStripped;
        return {
          id: String(idx + 1),
          name,
          oid: w.oidStripped,
          description: `Type=${w.type}`,
          dataType: inferDataType(w.type),
          access: 'read-only' as const,
        };
      });

    const template = {
      id: `elenos-etg5000-complete-${Date.now()}`,
      name: templateNameInput?.trim() || 'Elenos ETG5000 - Complete OID',
      description: `Complete OID walk from ${host}${walked.length && walked[0].value && typeof walked[0].value === 'string' ? ' (fallback from snmp_full_walk.txt)' : ''}`,
      manufacturer: 'Elenos',
      model: 'ETG5000',
      version: 'auto',
      baseOID: walkRoot,
      oids,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Save to attached_assets for reuse/download
    const outDir = path.resolve(process.cwd(), 'attached_assets');
    await fs.promises.mkdir(outDir, { recursive: true });
    // Create a filename from the template name
    const slug = (template.name || 'template')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    const outPath = path.join(outDir, `${slug}_${Date.now()}.json`);
    await fs.promises.writeFile(outPath, JSON.stringify(template, null, 2), 'utf-8');

    res.json({ success: true, count: oids.length, templatePath: `/attached_assets/${path.basename(outPath)}`, template });
  } catch (error) {
    console.error('SNMP walk failed:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

function inferDataType(typeName: string): 'INTEGER' | 'OCTET STRING' | 'OBJECT IDENTIFIER' | 'Counter32' | 'Gauge32' {
  switch (typeName) {
    case 'Integer':
    case 'Integer32':
      return 'INTEGER';
    case 'OctetString':
      return 'OCTET STRING';
    case 'ObjectIdentifier':
      return 'OBJECT IDENTIFIER';
    case 'Counter':
    case 'Counter32':
      return 'Counter32';
    case 'Gauge':
    case 'Gauge32':
      return 'Gauge32';
    default:
      return 'OCTET STRING';
  }
}

// Start the poller
router.post('/start', (req, res) => {
  try {
    snmpPoller.start();
    res.json({ message: 'SNMP poller started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start poller' });
  }
});

// Stop the poller
router.post('/stop', (req, res) => {
  try {
    snmpPoller.stop();
    res.json({ message: 'SNMP poller stopped' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to stop poller' });
  }
});

// Get poller status
router.get('/status', (req, res) => {
  try {
    res.json({ 
      running: snmpPoller.isRunning(),
      deviceCount: snmpPoller.getAllDevices().length,
      resultCount: snmpPoller.getResults().length
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Get polling results
router.get('/results', (req, res) => {
  const deviceId = req.query.deviceId as string;
  const limit = parseInt(req.query.limit as string) || 100;
  const results = snmpPoller.getResults(deviceId, limit);
  res.json(results);
});

// Clear all polling results
router.delete('/results', (req, res) => {
  try {
    snmpPoller.clearResults();
    res.json({ message: 'All polling results cleared' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear results' });
  }
});

// WebSocket-like endpoint for real-time updates (using Server-Sent Events)
router.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Cache-Control'
  });

  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connection event
  sendEvent('connected', { message: 'Connected to SNMP events' });

  // Listen for poller events (simplified without event emitter for now)
  const onPollComplete = (result: DeviceResult) => {
    sendEvent('pollComplete', result);
  };

  // Send periodic updates with current results and database data
  const updateInterval = setInterval(async () => {
    try {
      // Get in-memory results
      const results = snmpPoller.getResults();
      
      // Get latest metrics from database for all active transmitters
      const transmitters = await databaseService.getAllTransmitters();
      const latestMetrics = await Promise.all(
        transmitters.map(async (transmitter) => {
          try {
            const metrics = await databaseService.getLatestMetrics(transmitter.id);
            return { transmitterId: transmitter.id, metrics };
          } catch (error) {
            console.error(`Failed to get metrics for transmitter ${transmitter.id}:`, error);
            return null;
          }
        })
      );
      
      const validMetrics = latestMetrics.filter(m => m !== null);
      
      sendEvent('update', { 
        results: results.slice(-10), // Send last 10 SNMP results
        latestMetrics: validMetrics // Send latest database metrics
      });
    } catch (error) {
      console.error('Error sending SSE update:', error);
    }
  }, 5000);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(updateInterval);
  });
});

// Get all latest transmitter metrics from database
router.get('/transmitters/metrics/latest', async (req, res) => {
  try {
    const transmitters = await databaseService.getAllTransmitters();
    const latestMetrics = await Promise.all(
      transmitters.map(async (transmitter) => {
        try {
          const metrics = await databaseService.getLatestMetrics(transmitter.id);
          return { transmitterId: transmitter.id, metrics };
        } catch (error) {
          console.error(`Failed to get metrics for transmitter ${transmitter.id}:`, error);
          return { transmitterId: transmitter.id, metrics: null };
        }
      })
    );
    res.json(latestMetrics.filter(item => item.metrics !== null));
  } catch (error) {
    console.error('Failed to get all latest metrics:', error);
    res.status(500).json({ error: 'Failed to get all latest metrics' });
  }
});

// Get live transmitter metrics from database
router.get('/transmitters/:id/metrics/latest', async (req, res) => {
  try {
    const transmitterId = req.params.id;
    const metrics = await databaseService.getLatestMetrics(transmitterId);
    res.json(metrics);
  } catch (error) {
    console.error('Failed to get latest metrics:', error);
    res.status(500).json({ error: 'Failed to get latest metrics' });
  }
});

// Get transmitter metrics within a time range
router.get('/transmitters/:id/metrics', async (req, res) => {
  try {
    const transmitterId = req.params.id;
    const { start, end } = req.query;
    
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query parameters are required' });
    }
    
    const startDate = new Date(start as string);
    const endDate = new Date(end as string);
    
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }
    
    const metrics = await databaseService.getMetricsRange(transmitterId, startDate, endDate);
    res.json(metrics);
  } catch (error) {
    console.error('Failed to get metrics range:', error);
    res.status(500).json({ error: 'Failed to get metrics range' });
  }
});

// Get all transmitters
router.get('/transmitters', async (req, res) => {
  try {
    const txs = await databaseService.getAllTransmitters();
    // For consistency with /devices, expose displayLabel as label for clients
    const mapped = txs.map(tx => ({
      ...tx,
      label: tx.displayLabel ?? undefined,
    }));
    res.json(mapped);
  } catch (error) {
    console.error('Failed to get transmitters:', error);
    res.status(500).json({ error: 'Failed to get transmitters' });
  }
});

// Create a new transmitter (attach to a site)
router.post('/transmitters', async (req, res) => {
  try {
    const data = req.body || {};

    if (!data.siteId) {
      return res.status(400).json({ error: 'siteId is required' });
    }

    // Basic mapping and defaults
    const transmitterData = {
      siteId: data.siteId,
      name: data.name || 'Transmitter',
      displayOrder: typeof data.displayOrder === 'number' ? data.displayOrder : (typeof data.displayOrder === 'string' ? parseInt(data.displayOrder, 10) || 0 : 0),
      frequency: typeof data.frequency === 'number' ? data.frequency : parseFloat(data.frequency || '0') || 0,
      power: typeof data.power === 'number' ? data.power : 0,
      status: data.status || 'unknown',
      snmpHost: data.snmpHost || '127.0.0.1',
      snmpPort: typeof data.snmpPort === 'number' ? data.snmpPort : 161,
      snmpCommunity: data.snmpCommunity || 'public',
      snmpVersion: typeof data.snmpVersion === 'number' ? data.snmpVersion : 1,
      oids: Array.isArray(data.oids) ? data.oids : [],
      pollInterval: typeof data.pollInterval === 'number' ? data.pollInterval : 10000,
      isActive: data.isActive !== undefined ? !!data.isActive : true,
    };

    const created = await databaseService.upsertTransmitter({
      ...transmitterData,
      displayLabel: data.displayLabel,
    });
    // Ensure poller reflects transmitter changes
    await snmpPoller.loadDevicesFromDatabase();
    res.status(201).json({
      ...created,
      label: created.displayLabel ?? undefined,
    });
  } catch (error) {
    console.error('Failed to create transmitter:', error);
    res.status(500).json({ error: 'Failed to create transmitter' });
  }
});

// Update an existing transmitter
router.put('/transmitters/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body || {};

    const transmitterData = {
      id,
      ...(data.siteId ? { siteId: data.siteId } : {}),
      ...(data.name ? { name: data.name } : {}),
      ...(data.displayOrder !== undefined ? { displayOrder: typeof data.displayOrder === 'number' ? data.displayOrder : (typeof data.displayOrder === 'string' ? parseInt(data.displayOrder, 10) || 0 : undefined) } : {}),
      ...(data.frequency !== undefined ? { frequency: typeof data.frequency === 'number' ? data.frequency : parseFloat(data.frequency) || 0 } : {}),
      ...(data.power !== undefined ? { power: typeof data.power === 'number' ? data.power : parseFloat(data.power) || 0 } : {}),
      ...(data.status ? { status: data.status } : {}),
      ...(data.snmpHost ? { snmpHost: data.snmpHost } : {}),
      ...(data.snmpPort !== undefined ? { snmpPort: typeof data.snmpPort === 'number' ? data.snmpPort : parseInt(data.snmpPort, 10) || 161 } : {}),
      ...(data.snmpCommunity ? { snmpCommunity: data.snmpCommunity } : {}),
      ...(data.snmpVersion !== undefined ? { snmpVersion: typeof data.snmpVersion === 'number' ? data.snmpVersion : parseInt(data.snmpVersion, 10) || 1 } : {}),
      ...(data.oids !== undefined ? { oids: Array.isArray(data.oids) ? data.oids : [] } : {}),
      ...(data.pollInterval !== undefined ? { pollInterval: typeof data.pollInterval === 'number' ? data.pollInterval : parseInt(data.pollInterval, 10) || 10000 } : {}),
      ...(data.isActive !== undefined ? { isActive: !!data.isActive } : {}),
      ...(data.displayLabel !== undefined ? { displayLabel: data.displayLabel } : {}),
    };

    const updated = await databaseService.upsertTransmitter(transmitterData);
    // Ensure poller reflects transmitter changes
    await snmpPoller.loadDevicesFromDatabase();
    res.json({
      ...updated,
      label: updated.displayLabel ?? undefined,
    });
  } catch (error) {
    console.error('Failed to update transmitter:', error);
    res.status(500).json({ error: 'Failed to update transmitter' });
  }
});

// Delete a transmitter
router.delete('/transmitters/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ok = await databaseService.deleteTransmitter(id);
    if (!ok) {
      return res.status(404).json({ error: 'Transmitter not found' });
    }
    // Ensure poller reflects transmitter deletion
    await snmpPoller.loadDevicesFromDatabase();
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete transmitter:', error);
    res.status(500).json({ error: 'Failed to delete transmitter' });
  }
});

// Get all sites
router.get('/sites', async (req, res) => {
  try {
    const sites = await databaseService.getAllSites();
    res.json(sites);
  } catch (error) {
    console.error('Failed to get sites:', error);
    res.status(500).json({ error: 'Failed to get sites' });
  }
});

// Create a new site
router.post('/sites', async (req, res) => {
  try {
    const siteData = req.body;
    const newSite = await databaseService.createSite(siteData);
    res.status(201).json(newSite);
  } catch (error) {
    console.error('Failed to create site:', error);
    res.status(500).json({ error: 'Failed to create site' });
  }
});

// Update an existing site
router.put('/sites/:id', async (req, res) => {
  try {
    const siteId = req.params.id;
    const updates = req.body;
    console.log('[snmp routes] update site request', siteId, updates);
    const updatedSite = await databaseService.updateSite(siteId, updates);

    if (!updatedSite) {
      return res.status(404).json({ error: 'Site not found' });
    }

    res.json(updatedSite);
  } catch (error) {
    console.error('Failed to update site:', error);
    res.status(500).json({ error: 'Failed to update site' });
  }
});

// Delete a site
router.delete('/sites/:id', async (req, res) => {
  try {
    const siteId = req.params.id;
    const ok = await databaseService.deleteSite(siteId);
    if (!ok) {
      return res.status(404).json({ error: 'Site not found' });
    }
    res.status(204).send();
  } catch (error) {
    console.error('Failed to delete site:', error);
    res.status(500).json({ error: 'Failed to delete site' });
  }
});

export default router;

// Traps endpoints
router.get('/traps/latest', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const transmitterId = req.query.transmitterId ? String(req.query.transmitterId) : undefined;
    const siteId = req.query.siteId ? String(req.query.siteId) : undefined;
    const sourceHost = req.query.sourceHost ? String(req.query.sourceHost) : undefined;

    const rows = await databaseService.getLatestTraps({ limit, transmitterId, siteId, sourceHost });
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch latest traps:', error);
    res.status(500).json({ error: 'Failed to fetch latest traps' });
  }
});

router.get('/traps/range', async (req, res) => {
  try {
    const start = req.query.start ? new Date(String(req.query.start)) : undefined;
    const end = req.query.end ? new Date(String(req.query.end)) : undefined;
    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query params are required (ISO date strings)' });
    }
    const transmitterId = req.query.transmitterId ? String(req.query.transmitterId) : undefined;
    const siteId = req.query.siteId ? String(req.query.siteId) : undefined;
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;

    const rows = await databaseService.getTrapsRange({ startTime: start, endTime: end, transmitterId, siteId, limit });
    res.json(rows);
  } catch (error) {
    console.error('Failed to fetch traps range:', error);
    res.status(500).json({ error: 'Failed to fetch traps range' });
  }
});