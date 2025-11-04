import * as snmp from 'net-snmp';
import { databaseService } from './database-service';
import readline from 'node:readline';

// Map net-snmp numeric ObjectType to readable string
function typeNameFromVarbindType(type: number | undefined): string | undefined {
  if (typeof type !== 'number') return undefined;
  const anyObjType = (snmp as any).ObjectType as unknown as Record<number, string>;
  return anyObjType[type] ?? undefined;
}

function normalizeVarbinds(varbinds: Array<{ oid: string; type?: number; value: any }>): Array<{ oid: string; type?: string; value: any }> {
  return (varbinds || []).map((vb) => ({
    oid: vb.oid,
    type: typeNameFromVarbindType(vb.type),
    value: vb.value,
  }));
}

function extractTrapOids(varbinds: Array<{ oid: string; type?: string; value: any }>): { trapOid?: string; enterpriseOid?: string } {
  const trapOidV2 = varbinds.find((vb) => vb.oid === '1.3.6.1.6.3.1.1.4.1.0');
  const enterpriseOidV1 = varbinds.find((vb) => vb.oid === '1.3.6.1.4.1.0');
  return {
    trapOid: typeof trapOidV2?.value === 'string' ? trapOidV2.value : undefined,
    enterpriseOid: typeof enterpriseOidV1?.value === 'string' ? enterpriseOidV1.value : undefined,
  };
}

async function promptFallbackOrExit(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  return await new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(
      'Binding to UDP port 162 requires elevated privileges.\n' +
        'Press [f] to fallback to 10162, or [Enter] to exit and re-run as root/setcap: ',
      (answer) => {
        rl.close();
        resolve(String(answer).trim().toLowerCase() === 'f');
      },
    );
  });
}

export class SNMPTrapManager {
  private receiver: any = null;
  private listening = false;
  private triedFallback = false;
  private boundPort?: number;

  async start(): Promise<void> {
    if (this.listening) return;

    const desiredPort = parseInt(process.env.SNMP_TRAP_PORT || process.env.TRAP_PORT || '162', 10);
    const fallbackPort = parseInt(process.env.SNMP_TRAP_FALLBACK_PORT || '10162', 10);
    const requirePrivileged = (process.env.SNMP_TRAP_REQUIRE_PRIVILEGED || 'true').toLowerCase() === 'true';
    const autoFallback = (process.env.SNMP_TRAP_AUTO_FALLBACK || 'false').toLowerCase() === 'true';

    const callback = async (error: Error | null, data: any) => {
      if (error) {
        const code = (error as any)?.code;
        if ((code === 'EACCES' || code === 'EADDRINUSE') && !this.triedFallback && desiredPort !== fallbackPort) {
          if (code === 'EACCES' && requirePrivileged && !autoFallback) {
            const doFallback = await promptFallbackOrExit();
            if (!doFallback) {
              console.error(
                'SNMP Trap Receiver cannot bind to 162 without privileges. Re-run with sudo -E npm run dev, or grant capability: \n' +
                  "sudo setcap 'cap_net_bind_service=+ep' /home/tapa/.trae-server/binaries/node/versions/22.20.0/bin/node",
              );
              // stop receiver if partially created
              try { this.receiver?.close?.(() => {}); } catch {}
              return; // keep server alive; receiver disabled
            }
          }
          try {
            this.triedFallback = true;
            try { this.receiver?.close?.(() => {}); } catch {}
            this.receiver = (snmp as any).createReceiver({ port: fallbackPort, transport: 'udp4', disableAuthorization: true }, callback);
            this.listening = true;
            this.boundPort = fallbackPort;
            console.warn(
              `SNMP Trap Receiver fell back to port ${fallbackPort} (${code}). To use 162, run with root or setcap cap_net_bind_service.`,
            );
          } catch (err2) {
            console.error('Failed to start SNMP trap receiver on fallback port:', err2);
          }
        } else {
          console.error('SNMP trap receiver error:', error);
        }
        return;
      }
      try {
        await this.handleNotification(data, this.boundPort ?? desiredPort);
      } catch (e) {
        console.error('Failed to persist SNMP notification:', e);
      }
    };

    // Initial bind attempt
    try {
      this.receiver = (snmp as any).createReceiver({ port: desiredPort, transport: 'udp4', disableAuthorization: true }, callback);
      this.listening = true;
      this.boundPort = desiredPort;
      console.log(`SNMP Trap Receiver attempting to listen on port ${desiredPort}`);
    } catch (err: any) {
      const code = err?.code;
      if (code === 'EACCES' || code === 'EADDRINUSE') {
        if (code === 'EACCES' && requirePrivileged && !autoFallback) {
          const doFallback = await promptFallbackOrExit();
          if (!doFallback) {
            console.error(
              'SNMP Trap Receiver cannot bind to 162 without privileges. Re-run with sudo -E npm run dev, or grant capability: \n' +
                "sudo setcap 'cap_net_bind_service=+ep' /home/tapa/.trae-server/binaries/node/versions/22.20.0/bin/node",
            );
            throw err;
          }
        }
        try {
          this.triedFallback = true;
          this.receiver = (snmp as any).createReceiver({ port: fallbackPort, transport: 'udp4', disableAuthorization: true }, callback);
          this.listening = true;
          this.boundPort = fallbackPort;
          console.warn(
            `SNMP Trap Receiver fell back to port ${fallbackPort} (${code}). To use 162, run with root or setcap cap_net_bind_service.`,
          );
        } catch (err2) {
          console.error('Failed to start SNMP trap receiver on fallback port:', err2);
          throw err2;
        }
      } else {
        console.error('Failed to start SNMP trap receiver:', err);
        throw err;
      }
    }
  }

  private async handleNotification(data: any, fallbackPort: number): Promise<void> {
    const rinfo = data?.rinfo || data?.source || {};
    const varbindsRaw: Array<{ oid: string; type?: number; value: any }> = data?.pdu?.varbinds || data?.varbinds || [];
    const varbinds = normalizeVarbinds(varbindsRaw);
    const { trapOid, enterpriseOid } = extractTrapOids(varbinds);

    const sourceHost: string = rinfo?.address || rinfo?.host || 'unknown';
    const sourcePort: number = typeof rinfo?.port === 'number' ? rinfo.port : (typeof data?.port === 'number' ? data.port : fallbackPort);

    const community: string | undefined = data?.pdu?.community || data?.community || data?.securityName || undefined;

    let versionNum: 0 | 1 = 1;
    const version = data?.version;
    if (version === (snmp as any).Version1) versionNum = 0;
    else if (version === (snmp as any).Version2c) versionNum = 1;

    let transmitterId: string | undefined = undefined;
    let siteId: string | undefined = undefined;
    try {
      const allTx = await databaseService.getAllTransmitters();
      const matched = allTx.find((tx: any) => tx.snmpHost === sourceHost);
      if (matched) {
        transmitterId = matched.id;
        siteId = matched.siteId;
      }
    } catch {
      // non-fatal
    }

    await databaseService.storeSnmpTrap({
      transmitterId,
      siteId,
      sourceHost,
      sourcePort,
      community,
      version: versionNum,
      trapOid,
      enterpriseOid,
      varbinds,
    });
  }

  async stop(): Promise<void> {
    if (!this.receiver) return;
    try {
      await new Promise<void>((resolve) => {
        try {
          this.receiver.close?.(() => resolve());
        } catch {
          resolve();
        }
      });
    } finally {
      this.receiver = null;
      this.listening = false;
      this.triedFallback = false;
      this.boundPort = undefined;
    }
  }
}

export const snmpTrapManager = new SNMPTrapManager();