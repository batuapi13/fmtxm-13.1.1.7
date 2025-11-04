import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { transmitters, transmitterMetrics, sites, alarms, snmpTraps } from '../../shared/schema';
import { eq, desc, and, gte, lte } from 'drizzle-orm';
import type { DeviceResult } from './snmp-poller';

// Database connection - enforce single configured DATABASE_URL
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set to run the server');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

export interface TransmitterMetricData {
  transmitterId: string;
  timestamp: Date;
  powerOutput?: number;
  frequency?: number;
  vswr?: number;
  temperature?: number;
  forwardPower?: number;
  reflectedPower?: number;
  status: string;
  snmpData?: any;
  errorMessage?: string;
}

export class DatabaseService {
  /**
   * Initialize schema changes safely on startup.
   * Ensures optional columns exist without touching Timescale aggregates.
   */
  async initializeSchema(): Promise<void> {
    try {
      // Add display_label to transmitters if missing
      await pool.query(
        `ALTER TABLE transmitters ADD COLUMN IF NOT EXISTS display_label TEXT;`
      );
      console.log('Schema initialized: ensured transmitters.display_label exists');

      // Add display_order to transmitters if missing and initialize to 0
      await pool.query(
        `ALTER TABLE transmitters ADD COLUMN IF NOT EXISTS display_order INTEGER DEFAULT 0;`
      );
      await pool.query(
        `UPDATE transmitters SET display_order = COALESCE(display_order, 0);`
      );
      console.log('Schema initialized: ensured transmitters.display_order exists');

      // Ensure poll_interval default is 10000ms and migrate existing rows from 30000ms
      await pool.query(
        `ALTER TABLE transmitters ALTER COLUMN poll_interval SET DEFAULT 10000;`
      );
      const updateRes = await pool.query(
        `UPDATE transmitters SET poll_interval = 10000 WHERE poll_interval IS NULL OR poll_interval = 30000;`
      );
      console.log(`Schema migration: poll_interval default set to 10000; rows updated=${updateRes.rowCount}`);

      // Ensure snmp_traps table exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS snmp_traps (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          transmitter_id VARCHAR REFERENCES transmitters(id),
          site_id VARCHAR REFERENCES sites(id),
          source_host TEXT NOT NULL,
          source_port INTEGER NOT NULL,
          community TEXT,
          version INTEGER NOT NULL,
          trap_oid TEXT,
          enterprise_oid TEXT,
          varbinds JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS snmp_traps_created_at_idx ON snmp_traps (created_at);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS snmp_traps_source_host_idx ON snmp_traps (source_host);`);
      await pool.query(`CREATE INDEX IF NOT EXISTS snmp_traps_transmitter_idx ON snmp_traps (transmitter_id);`);
      console.log('Schema initialized: ensured snmp_traps table and indexes exist');
    } catch (error) {
      console.error('Schema initialization failed:', error);
    }
  }
  // Normalize a site row to ensure contactInfo is an object
  private normalizeSite(row: any): any {
    if (!row) return row;
    let contact = row.contactInfo;
    if (contact) {
      if (typeof contact === 'string') {
        const trimmed = contact.trim();
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed === 'object') {
            contact = parsed;
          } else {
            contact = { technician: '', phone: '', email: contact };
          }
        } catch (_) {
          // If it's not valid JSON, treat as legacy email string
          contact = { technician: '', phone: '', email: contact };
        }
      }
      // if it's already an object, leave as is
    } else {
      contact = null;
    }
    return { ...row, contactInfo: contact };
  }
  /**
   * Get a single transmitter by ID
   */
  async getTransmitterById(transmitterId: string): Promise<any | null> {
    try {
      const rows = await db
        .select()
        .from(transmitters)
        .where(eq(transmitters.id, transmitterId))
        .limit(1);
      return rows[0] || null;
    } catch (error) {
      console.error('Failed to get transmitter by id:', error);
      throw error;
    }
  }

  /**
   * Get a single site by ID
   */
  async getSiteById(siteId: string): Promise<any | null> {
    try {
      const rows = await db
        .select()
        .from(sites)
        .where(eq(sites.id, siteId))
        .limit(1);
      const row = rows[0] || null;
      return row ? this.normalizeSite(row) : null;
    } catch (error) {
      console.error('Failed to get site by id:', error);
      throw error;
    }
  }

  /**
   * Store SNMP poll result in the database
   */
  async storeTransmitterMetrics(deviceId: string, result: DeviceResult): Promise<void> {
    try {
      // First, check if transmitter exists
      const transmitter = await db
        .select()
        .from(transmitters)
        .where(eq(transmitters.id, deviceId))
        .limit(1);

      if (transmitter.length === 0) {
        console.warn(`Transmitter ${deviceId} not found in database, skipping metric storage`);
        return;
      }

      // Parse SNMP data to extract metrics
      const metrics = this.parseSnmpData(result);

      // If radio station/channel name OID is present, update transmitter name
      const radioNameOid = '1.3.6.1.4.1.31946.3.1.7';
      const radioNameOidScalar = '1.3.6.1.4.1.31946.3.1.7.0';
      const rawRadioName = result.data ? (result.data[radioNameOid] ?? result.data[radioNameOidScalar]) : undefined;
      let radioName: string | undefined;
      if (rawRadioName) {
        if (typeof rawRadioName === 'string') {
          radioName = rawRadioName.trim();
        } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(rawRadioName)) {
          radioName = rawRadioName.toString('utf8').trim();
        } else if (typeof rawRadioName === 'object' && (rawRadioName as any)?.type === 'Buffer' && Array.isArray((rawRadioName as any)?.data)) {
          // Handle case where Buffer was serialized in JSON
          try {
            radioName = Buffer.from((rawRadioName as any).data).toString('utf8').trim();
          } catch {}
        }
      }
      if (radioName && radioName.length > 0) {
        const currentName = transmitter[0]?.name;
        if (currentName !== radioName) {
          await this.upsertTransmitter({ id: deviceId, name: radioName });
        }
      }

      // Insert metrics into TimescaleDB hypertable
      await db.insert(transmitterMetrics).values({
        transmitterId: deviceId,
        timestamp: result.timestamp,
        powerOutput: metrics.powerOutput,
        frequency: metrics.frequency,
        vswr: metrics.vswr,
        temperature: metrics.temperature,
        forwardPower: metrics.forwardPower,
        reflectedPower: metrics.reflectedPower,
        // Use parsed status; offline unless OIDs indicate availability
        status: metrics.status ?? 'offline',
        snmpData: result.data,
        errorMessage: result.error
      });

      console.log(`Stored metrics for transmitter ${deviceId} at ${result.timestamp}`);
    } catch (error) {
      console.error(`Failed to store metrics for transmitter ${deviceId}:`, error);
      throw error;
    }
  }

  /**
   * Parse SNMP data to extract transmitter metrics
   * This is a basic implementation - customize based on your SNMP OIDs
   */
  private parseSnmpData(result: DeviceResult): Partial<TransmitterMetricData> {
    const metrics: Partial<TransmitterMetricData> = {};

    if (!result.success || !result.data) {
      return metrics;
    }

    // Map Elenos ETG base OIDs to metric names; support optional instance indices (e.g., .4) and scalar (.0)
    const oidBaseMappings: Record<string, keyof TransmitterMetricData> = {
      '1.3.6.1.4.1.31946.4.2.6.10.1': 'forwardPower',
      '1.3.6.1.4.1.31946.4.2.6.10.2': 'reflectedPower',
      '1.3.6.1.4.1.31946.4.2.6.10.14': 'frequency',
    };
    // Optional common metrics if present (kept as-is with scalar index)
    const directOidMappings: Record<string, keyof TransmitterMetricData> = {
      '1.3.6.1.2.1.1.3.0': 'powerOutput',
    };

    // Helper: resolve a metric name for an OID, handling trailing ".0" or instance indices like ".4"
    const resolveMetricName = (oid: string): keyof TransmitterMetricData | undefined => {
      if (directOidMappings[oid as keyof typeof directOidMappings]) {
        return directOidMappings[oid as keyof typeof directOidMappings];
      }
      // Check direct base
      if (oidBaseMappings[oid as keyof typeof oidBaseMappings]) {
        return oidBaseMappings[oid as keyof typeof oidBaseMappings];
      }
      // Strip scalar .0
      const withoutZero = oid.endsWith('.0') ? oid.slice(0, -2) : oid;
      if (oidBaseMappings[withoutZero as keyof typeof oidBaseMappings]) {
        return oidBaseMappings[withoutZero as keyof typeof oidBaseMappings];
      }
      // Strip one trailing instance index (e.g., .4)
      const lastDot = withoutZero.lastIndexOf('.');
      if (lastDot > -1) {
        const parent = withoutZero.substring(0, lastDot);
        if (oidBaseMappings[parent as keyof typeof oidBaseMappings]) {
          return oidBaseMappings[parent as keyof typeof oidBaseMappings];
        }
      }
      // Also handle cases like ".4.0" (strip .0 then index)
      if (oid.endsWith('.0')) {
        const base = oid.slice(0, -2);
        const lastDot2 = base.lastIndexOf('.');
        if (lastDot2 > -1) {
          const parent2 = base.substring(0, lastDot2);
          if (oidBaseMappings[parent2 as keyof typeof oidBaseMappings]) {
            return oidBaseMappings[parent2 as keyof typeof oidBaseMappings];
          }
        }
      }
      return undefined;
    };

    // Derive status with priority: 10.13 (active=1, standby=2) then 10.12 (on-air=2, otherwise standby)
    const statusBase13 = '1.3.6.1.4.1.31946.4.2.6.10.13';
    const statusBase12 = '1.3.6.1.4.1.31946.4.2.6.10.12';

    const getNumericValueForBase = (base: string): number | undefined => {
      const d = result.data as Record<string, any>;
      const direct = d[base];
      if (typeof direct === 'number') return direct;
      const scalar = d[`${base}.0`];
      if (typeof scalar === 'number') return scalar;
      // Find any offset like base.<n> or base.<n>.0
      for (const [k, v] of Object.entries(d)) {
        if (typeof v !== 'number') continue;
        if (k.startsWith(base + '.')) {
          const rest = k.substring(base.length + 1);
          if (/^\d+(\.0)?$/.test(rest)) return v as number;
        }
      }
      return undefined;
    };

    const v13 = getNumericValueForBase(statusBase13);
    const v12 = getNumericValueForBase(statusBase12);

    if (typeof v13 === 'number') {
      // StandbyStatus: active(1), stand-by(2)
      metrics.status = v13 === 1 ? 'active' : 'standby';
    } else if (typeof v12 === 'number') {
      // OnAirStatus: on-air(2) => active, otherwise standby
      metrics.status = v12 === 2 ? 'active' : 'standby';
    }
    // Availability rule: online if either OID has a value; offline if both missing
    const hasAvailability = typeof v13 === 'number' || typeof v12 === 'number';
    if (!hasAvailability) {
      metrics.status = 'offline';
    }

    // Parse SNMP data based on OID mappings
    for (const [oid, value] of Object.entries(result.data)) {
      const metricName = resolveMetricName(oid);
      if (metricName) {
        if (metricName === 'frequency' && typeof value === 'number') {
          // The OID returns tens of kHz; convert to MHz
          metrics.frequency = value / 100;
        } else if (typeof value === 'number') {
          (metrics as any)[metricName] = value;
        }
      }
    }

    // Calculate VSWR from forward and reflected power if not directly available
    if (metrics.forwardPower && metrics.reflectedPower && !metrics.vswr) {
      const reflectionCoeff = Math.sqrt(metrics.reflectedPower / metrics.forwardPower);
      metrics.vswr = (1 + reflectionCoeff) / (1 - reflectionCoeff);
    }

    return metrics;
  }

  /**
   * Get latest metrics for a transmitter
   */
  async getLatestMetrics(transmitterId: string): Promise<any> {
    try {
      const rows = await db
        .select()
        .from(transmitterMetrics)
        .where(eq(transmitterMetrics.transmitterId, transmitterId))
        .orderBy(desc(transmitterMetrics.timestamp))
        .limit(1);

      return rows[0] || null;
    } catch (error) {
      console.error('Failed to get latest metrics:', error);
      throw error;
    }
  }

  /**
   * Get metrics for a transmitter within a time range
   */
  async getMetricsRange(
    transmitterId: string,
    startTime: Date,
    endTime: Date,
    limit = 1000
  ): Promise<any[]> {
    try {
      const rows = await db
        .select()
        .from(transmitterMetrics)
        .where(
          and(
            eq(transmitterMetrics.transmitterId, transmitterId),
            gte(transmitterMetrics.timestamp, startTime),
            lte(transmitterMetrics.timestamp, endTime)
          )
        )
        .orderBy(desc(transmitterMetrics.timestamp))
        .limit(limit);

      return rows;
    } catch (error) {
      console.error('Failed to get metrics range:', error);
      throw error;
    }
  }

  /**
   * Get all transmitters from database
   */
  async getAllTransmitters(): Promise<any[]> {
    try {
      const rows = await db.select().from(transmitters).orderBy(transmitters.displayOrder);
      return rows;
    } catch (error) {
      console.error('Failed to get transmitters:', error);
      throw error;
    }
  }

  /**
   * Create or update a transmitter
   */
  async upsertTransmitter(transmitterData: any): Promise<any> {
    try {
      const { id } = transmitterData;
      if (id) {
        const existing = await db
          .select()
          .from(transmitters)
          .where(eq(transmitters.id, id))
          .limit(1);
        if (existing.length > 0) {
          await db
            .update(transmitters)
            .set(transmitterData)
            .where(eq(transmitters.id, id));
          return { ...existing[0], ...transmitterData };
        }
      }

      const inserted = await db.insert(transmitters).values(transmitterData).returning();
      return inserted[0];
    } catch (error) {
      console.error('Failed to upsert transmitter:', error);
      throw error;
    }
  }

  /**
   * Get all sites from database
   */
  async getAllSites(): Promise<any[]> {
    try {
      const rows = await db.select().from(sites).orderBy(sites.name);
      return rows.map((row) => this.normalizeSite(row));
    } catch (error) {
      console.error('Failed to get sites:', error);
      throw error;
    }
  }

  /**
   * Create a new site
   */
  async createSite(siteData: any): Promise<any> {
    try {
      const inserted = await db.insert(sites).values(siteData).returning();
      return this.normalizeSite(inserted[0]);
    } catch (error) {
      console.error('Failed to create site:', error);
      throw error;
    }
  }

  /**
   * Update an existing site
   */
  async updateSite(siteId: string, updates: any): Promise<any> {
    try {
      await db.update(sites).set(updates).where(eq(sites.id, siteId));
      const rows = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
      return this.normalizeSite(rows[0]);
    } catch (error) {
      console.error('Failed to update site:', error);
      throw error;
    }
  }

  /**
   * Delete a single transmitter and cascade delete related metrics and alarms
   */
  async deleteTransmitter(transmitterId: string): Promise<boolean> {
    try {
      const res = await db.delete(transmitters).where(eq(transmitters.id, transmitterId));
      return (res as any)?.rowCount > 0;
    } catch (error) {
      console.error('Failed to delete transmitter:', error);
      throw error;
    }
  }

  /**
   * Delete a site and cascade delete related transmitters, metrics, and alarms
   */
  async deleteSite(siteId: string): Promise<boolean> {
    try {
      const res = await db.delete(sites).where(eq(sites.id, siteId));
      return (res as any)?.rowCount > 0;
    } catch (error) {
      console.error('Failed to delete site:', error);
      throw error;
    }
  }

  /**
   * Store an SNMP trap event
   */
  async storeSnmpTrap(trap: {
    transmitterId?: string;
    siteId?: string;
    sourceHost: string;
    sourcePort: number;
    community?: string;
    version: 0 | 1;
    trapOid?: string;
    enterpriseOid?: string;
    varbinds: Array<{ oid: string; type?: string; value: any }>;
  }): Promise<void> {
    try {
      await db.insert(snmpTraps).values({
        transmitterId: trap.transmitterId,
        siteId: trap.siteId,
        sourceHost: trap.sourceHost,
        sourcePort: trap.sourcePort,
        community: trap.community,
        version: trap.version,
        trapOid: trap.trapOid,
        enterpriseOid: trap.enterpriseOid,
        varbinds: trap.varbinds as any,
      });
    } catch (error) {
      console.error('Failed to store SNMP trap:', error);
      throw error;
    }
  }

  /**
   * Query latest traps with optional filters
   */
  async getLatestTraps(params: {
    limit?: number;
    transmitterId?: string;
    siteId?: string;
    sourceHost?: string;
  }): Promise<any[]> {
    try {
      const limit = params.limit && params.limit > 0 ? params.limit : 100;
      const rows = await db.select().from(snmpTraps).orderBy(desc(snmpTraps.createdAt)).limit(limit);
      return rows.filter((r) => (
        (!params.transmitterId || r.transmitterId === params.transmitterId) &&
        (!params.siteId || r.siteId === params.siteId) &&
        (!params.sourceHost || r.sourceHost === params.sourceHost)
      ));
    } catch (error) {
      console.error('Failed to fetch latest traps:', error);
      throw error;
    }
  }

  /**
   * Query traps in a time range
   */
  async getTrapsRange(params: {
    startTime: Date;
    endTime: Date;
    transmitterId?: string;
    siteId?: string;
    limit?: number;
  }): Promise<any[]> {
    try {
      const limit = params.limit && params.limit > 0 ? params.limit : 1000;
      const rows = await db
        .select()
        .from(snmpTraps)
        .where(and(
          gte(snmpTraps.createdAt, params.startTime),
          lte(snmpTraps.createdAt, params.endTime)
        ))
        .orderBy(desc(snmpTraps.createdAt))
        .limit(limit);
      return rows.filter((r) => (
        (!params.transmitterId || r.transmitterId === params.transmitterId) &&
        (!params.siteId || r.siteId === params.siteId)
      ));
    } catch (error) {
      console.error('Failed to fetch traps range:', error);
      throw error;
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await pool.end();
  }
}

// Export singleton instance
export const databaseService = new DatabaseService();