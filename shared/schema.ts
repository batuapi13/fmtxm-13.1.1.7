import { sql } from "drizzle-orm";
import { 
  pgTable, 
  text, 
  varchar, 
  timestamp, 
  real, 
  integer, 
  boolean, 
  jsonb,
  index,
  primaryKey
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Users table
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

// Sites table - FM transmitter sites
export const sites = pgTable("sites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  location: text("location").notNull(),
  latitude: real("latitude"),
  longitude: real("longitude"),
  address: text("address"),
  contactInfo: text("contact_info"),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Transmitters table - Individual FM transmitters at sites
export const transmitters = pgTable("transmitters", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  siteId: varchar("site_id").references(() => sites.id).notNull(),
  name: text("name").notNull(),
  displayLabel: text("display_label"),
  // Order used for display in UI
  displayOrder: integer("display_order").default(0),
  frequency: real("frequency").notNull(), // MHz
  power: real("power").notNull(), // Watts
  status: text("status").notNull().default("unknown"), // active, standby, offline, fault
  snmpHost: text("snmp_host").notNull(),
  snmpPort: integer("snmp_port").default(161),
  snmpCommunity: text("snmp_community").default("public"),
  snmpVersion: integer("snmp_version").default(1), // 0=v1, 1=v2c
  oids: jsonb("oids").notNull(), // SNMP OIDs to poll
  pollInterval: integer("poll_interval").default(10000), // milliseconds
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});



// Transmitter metrics - Time-series data (TimescaleDB hypertable)
export const transmitterMetrics = pgTable("transmitter_metrics", {
  id: varchar("id").notNull().default(sql`gen_random_uuid()`),
  transmitterId: varchar("transmitter_id").references(() => transmitters.id).notNull(),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  powerOutput: real("power_output"), // Current power output
  frequency: real("frequency"), // Current frequency
  vswr: real("vswr"), // Voltage Standing Wave Ratio
  temperature: real("temperature"), // Transmitter temperature
  forwardPower: real("forward_power"),
  reflectedPower: real("reflected_power"),
  status: text("status").notNull(), // active, standby, offline, fault
  snmpData: jsonb("snmp_data"), // Raw SNMP response data
  errorMessage: text("error_message"), // If polling failed
}, (table) => ({
  // Composite primary key including timestamp for TimescaleDB compatibility
  pk: primaryKey({ columns: [table.transmitterId, table.timestamp] }),
  // Index for efficient queries
  timestampIdx: index("transmitter_metrics_timestamp_idx").on(table.timestamp),
  transmitterIdx: index("transmitter_metrics_transmitter_idx").on(table.transmitterId),
}));

// Alarms table - System alarms and alerts
export const alarms = pgTable("alarms", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  transmitterId: varchar("transmitter_id").references(() => transmitters.id).notNull(),
  siteId: varchar("site_id").references(() => sites.id).notNull(),
  severity: text("severity").notNull(), // critical, warning, info
  type: text("type").notNull(), // power_low, power_high, temperature_high, offline, etc.
  message: text("message").notNull(),
  isActive: boolean("is_active").default(true),
  acknowledgedBy: varchar("acknowledged_by").references(() => users.id),
  acknowledgedAt: timestamp("acknowledged_at"),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
}, (table) => ({
  activeIdx: index("alarms_active_idx").on(table.isActive),
  severityIdx: index("alarms_severity_idx").on(table.severity),
  createdAtIdx: index("alarms_created_at_idx").on(table.createdAt),
}));

// SNMP traps table - stores incoming trap events
export const snmpTraps = pgTable("snmp_traps", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  transmitterId: varchar("transmitter_id").references(() => transmitters.id),
  siteId: varchar("site_id").references(() => sites.id),
  sourceHost: text("source_host").notNull(),
  sourcePort: integer("source_port").notNull(),
  community: text("community"),
  version: integer("version").notNull(), // 0=v1, 1=v2c
  trapOid: text("trap_oid"),
  enterpriseOid: text("enterprise_oid"),
  varbinds: jsonb("varbinds").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  createdAtIdx: index("snmp_traps_created_at_idx").on(table.createdAt),
  sourceHostIdx: index("snmp_traps_source_host_idx").on(table.sourceHost),
  transmitterIdx: index("snmp_traps_transmitter_idx").on(table.transmitterId),
}));

// Schema validation
export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertSiteSchema = createInsertSchema(sites).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTransmitterSchema = createInsertSchema(transmitters).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertTransmitterMetricSchema = createInsertSchema(transmitterMetrics).omit({
  id: true,
  timestamp: true,
});

export const insertAlarmSchema = createInsertSchema(alarms).omit({
  id: true,
  createdAt: true,
});

export const insertSnmpTrapSchema = createInsertSchema(snmpTraps).omit({
  id: true,
  createdAt: true,
});

// Types
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

export type Site = typeof sites.$inferSelect;
export type InsertSite = z.infer<typeof insertSiteSchema>;

export type Transmitter = typeof transmitters.$inferSelect;
export type InsertTransmitter = z.infer<typeof insertTransmitterSchema>;

export type TransmitterMetric = typeof transmitterMetrics.$inferSelect;
export type InsertTransmitterMetric = z.infer<typeof insertTransmitterMetricSchema>;

export type Alarm = typeof alarms.$inferSelect;
export type InsertAlarm = z.infer<typeof insertAlarmSchema>;

export type SnmpTrap = typeof snmpTraps.$inferSelect;
export type InsertSnmpTrap = z.infer<typeof insertSnmpTrapSchema>;
