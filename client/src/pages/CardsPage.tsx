import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import StateCard from '@/components/StateCard';
import { Search, Filter, RefreshCw, Layers } from 'lucide-react';
import { extractAlarmsFromSites } from '@/utils/siteDataLoader';
import { snmpService } from '@/services/snmpService';
import type { SiteData, TransmitterData, TransmitterStatus, TransmitterType, TransmitterRole } from '@/types/dashboard';


// Helper to derive frequency (MHz) from metrics or raw SNMP data
const deriveFrequencyMHz = (metrics: any, transmitter: any): number => {
  const mFreq = typeof metrics?.frequency === 'number' ? metrics.frequency : undefined;
  if (typeof mFreq === 'number' && mFreq > 0) return mFreq;
  const sd = metrics?.snmpData || {};
  const rawFreq = typeof sd?.['1.3.6.1.4.1.31946.4.2.6.10.14'] === 'number'
    ? sd['1.3.6.1.4.1.31946.4.2.6.10.14']
    : (typeof sd?.['1.3.6.1.4.1.31946.4.2.6.10.14.0'] === 'number'
      ? sd['1.3.6.1.4.1.31946.4.2.6.10.14.0']
      : undefined);
  if (typeof rawFreq === 'number' && rawFreq > 0) return rawFreq / 100;
  const tFreq = typeof transmitter?.frequency === 'number'
    ? transmitter.frequency
    : (parseFloat(String(transmitter?.frequency || '0')) || 0);
  return tFreq || 0;
};

// Convert raw transmitter and site data to SiteData format
const convertMetricsToSiteData = (transmitters: any[], sites: any[], latestMetrics: any[]): SiteData[] => {
  // Group transmitters by site (use camelCase siteId from DB)
  const transmittersBySite = transmitters.reduce((acc: Record<string, any[]>, transmitter: any) => {
    const siteId = transmitter.siteId;
    if (!siteId) return acc;
    if (!acc[siteId]) {
      acc[siteId] = [];
    }
    acc[siteId].push(transmitter);
    return acc;
  }, {} as Record<string, any[]>);

  // Create metrics lookup keyed by transmitterId
  const metricsLookup = latestMetrics.reduce((acc: Record<string, any>, item: any) => {
    acc[item.transmitterId] = item.metrics;
    return acc;
  }, {} as Record<string, any>);

  return sites.map((site: any): SiteData => {
    // Sort by displayOrder
    const siteTransmitters = (transmittersBySite[site.id] || [])
      .slice()
      .sort((a: any, b: any) => {
        const ao = typeof a.displayOrder === 'number' ? a.displayOrder : 0;
        const bo = typeof b.displayOrder === 'number' ? b.displayOrder : 0;
        return ao - bo;
      });
    
    const transmitterData: TransmitterData[] = siteTransmitters.map((transmitter: any, index: number): TransmitterData => {
      const metrics = metricsLookup[transmitter.id] || {};
      const rawStatus = metrics?.status;
      const forwardPower = metrics?.forwardPower ?? 0;
      const reflectedPower = metrics?.reflectedPower ?? 0;
      const statusUi: TransmitterStatus = rawStatus === 'active'
        ? 'operational'
        : rawStatus === 'standby'
        ? 'warning'
        : rawStatus === 'fault'
        ? 'error'
        : 'offline';
      const isOnline = rawStatus !== 'offline';

      // Prefer server-managed displayLabel (exposed as label). Trim and ignore empty strings.
      const apiLabelCandidate = (typeof transmitter.label === 'string' ? transmitter.label : transmitter.displayLabel) as string | undefined;
      const apiLabel = apiLabelCandidate && apiLabelCandidate.trim().length > 0 ? apiLabelCandidate.trim() : undefined;
      const roleDefaultLabel = transmitter.role === 'active'
        ? 'Main'
        : transmitter.role === 'backup'
        ? 'Backup'
        : String(index + 1);
      const computedLabel = apiLabel ?? roleDefaultLabel;

      const computedFrequency = deriveFrequencyMHz(metrics, transmitter);
      return {
        id: transmitter.id,
        label: computedLabel,
        type: (transmitter.type || '1') as TransmitterType,
        role: (transmitter.role || 'active') as TransmitterRole,
        status: statusUi,
        channelName: transmitter.name || 'Unknown',
        frequency: computedFrequency.toString(),
        transmitPower: forwardPower,
        reflectPower: reflectedPower,
        mainAudio: false,
        backupAudio: false,
        connectivity: isOnline,
        lastSeen: metrics?.timestamp ? new Date(metrics.timestamp).toISOString() : new Date().toISOString(),
        isTransmitting: forwardPower > 0
      };
    });

    // Calculate counts
    const activeCount = transmitterData.filter(t => t.role === 'active').length;
    const backupCount = transmitterData.filter(t => t.role === 'backup').length;
    const standbyCount = transmitterData.filter(t => t.role === 'standby').length;
    // Use status-based logic: 'operational' == currently active; 'warning' == standby
    const runningCount = transmitterData.filter(t => t.status === 'operational').length;
    const alertCount = transmitterData.filter(t => t.status === 'error' || t.status === 'warning').length;

    // Determine overall status
    let overallStatus: TransmitterStatus = 'operational';
    if (alertCount > 0) {
      overallStatus = 'error';
    } else if (runningCount === 0) {
      overallStatus = 'offline';
    } else if (runningCount < activeCount) {
      overallStatus = 'warning';
    }

    return {
      id: site.id,
      name: site.name,
      location: site.location || 'Unknown',
      coordinates: {
        lat: site.latitude || 0,
        lng: site.longitude || 0
      },
      broadcaster: site.broadcaster || 'Unknown',
      transmitters: transmitterData,
      overallStatus,
      alerts: alertCount,
      activeTransmitterCount: activeCount,
      backupTransmitterCount: backupCount,
      standbyTransmitterCount: standbyCount,
      runningActiveCount: transmitterData.filter(t => t.role === 'active' && t.status === 'operational').length,
      runningBackupCount: transmitterData.filter(t => t.role === 'backup' && t.status === 'operational').length,
      activeStandbyCount: transmitterData.filter(t => t.role === 'standby' && t.status === 'operational').length
    };
  });
};

export default function CardsPage() {
  const [sites, setSites] = useState<SiteData[]>([]);
  const [filteredSites, setFilteredSites] = useState<SiteData[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'operational' | 'warning' | 'error'>('all');
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [totalAlarms, setTotalAlarms] = useState(0);
  const [transmitters, setTransmitters] = useState<any[]>([]);
  const [dbSites, setDbSites] = useState<any[]>([]);

  // Initialize data from database
  useEffect(() => {
    const initializeData = async () => {
      try {
        setIsLoading(true);
        
        // Fetch transmitters and sites from database
        const [transmittersData, sitesData] = await Promise.all([
          snmpService.getTransmitters(),
          snmpService.getSites()
        ]);
        
        setTransmitters(transmittersData);
        setDbSites(sitesData);
        
        // Get latest metrics and convert to site data
        const latestMetrics = await snmpService.getLatestTransmitterMetrics();
        const siteData = convertMetricsToSiteData(transmittersData, sitesData, latestMetrics);
        
        setSites(siteData);
        setFilteredSites(siteData);
        
        // Use centralized alarm extraction to ensure consistency with MapPage
        const alarms = extractAlarmsFromSites(siteData);
        setTotalAlarms(alarms.length);
      } catch (error) {
        console.error('Failed to initialize cards page data:', error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeData();
  }, []);

  // Filter sites based on search, status, and state
  useEffect(() => {
    let filtered = sites;

    if (searchTerm) {
      filtered = filtered.filter(site => 
        site.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        site.location.toLowerCase().includes(searchTerm.toLowerCase()) ||
        site.broadcaster.toLowerCase().includes(searchTerm.toLowerCase()) ||
        site.transmitters.some(tx => 
          tx.channelName.toLowerCase().includes(searchTerm.toLowerCase())
        )
      );
    }

    if (statusFilter !== 'all') {
      filtered = filtered.filter(site => site.overallStatus === statusFilter);
    }
    if (stateFilter) {
      filtered = filtered.filter(site => site.location.split(',')[0].trim() === stateFilter);
    }

    setFilteredSites(filtered);
  }, [sites, searchTerm, statusFilter, stateFilter]);

  // Group filtered sites by state
  const groupedByState = filteredSites.reduce((groups, site) => {
    // Extract state from location (e.g., "JOHOR, Malaysia" -> "JOHOR")
    const state = site.location.split(',')[0].trim();
    if (!groups[state]) {
      groups[state] = [];
    }
    groups[state].push(site);
    return groups;
  }, {} as Record<string, SiteData[]>);

  // Sort states alphabetically
  const sortedStates = Object.keys(groupedByState).sort();
  const allStates = Array.from(new Set(sites.map(s => s.location.split(',')[0].trim()))).sort();

  const handleSiteClick = (siteId: string) => {
    console.log(`Site selected: ${siteId}`);
  };

  const handleRefresh = async () => {
    console.log('Refreshing all site data...');
    try {
      const latestMetrics = await snmpService.getLatestTransmitterMetrics();
      const updatedSiteData = convertMetricsToSiteData(transmitters, dbSites, latestMetrics);
      setSites(updatedSiteData);
      setFilteredSites(updatedSiteData);
      
      // Update alarms count
      const alarms = extractAlarmsFromSites(updatedSiteData);
      setTotalAlarms(alarms.length);
    } catch (error) {
      console.error('Failed to refresh data:', error);
    }
  };

  

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-lg">Loading transmission sites...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="bg-card border-b border-border p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Layers className="w-6 h-6 text-primary" />
              <h1 className="text-2xl font-bold" data-testid="cards-page-title">
                Transmission Sites Overview
              </h1>
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <Badge variant="outline">
                {sites.length} Total Sites
              </Badge>
              <Badge variant="default">
                {sites.filter(s => s.overallStatus === 'operational').length} Online
              </Badge>
              {totalAlarms > 0 && (
                <Badge variant="destructive">
                  {totalAlarms} {totalAlarms === 1 ? 'Alarm' : 'Alarms'}
                </Badge>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleRefresh}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {/* Search and Filter Controls */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Search & Filter</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search sites, channels, or locations..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-10"
                    data-testid="search-input"
                  />
                </div>
              </div>
              
              <div className="flex gap-2">
                <Button
                  variant={statusFilter === 'all' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setStatusFilter('all')}
                  className="flex items-center gap-1"
                >
                  <Filter className="w-4 h-4" />
                  All
                </Button>
                <Button
                  variant={statusFilter === 'operational' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setStatusFilter('operational')}
                >
                  Operational
                </Button>
                <Button
                  variant={statusFilter === 'warning' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setStatusFilter('warning')}
                >
                  Warning
                </Button>
                <Button
                  variant={statusFilter === 'error' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setStatusFilter('error')}
                >
                  Error
                </Button>
              </div>
            </div>

            {/* State filter chips */}
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={stateFilter === null ? 'default' : 'outline'}
                onClick={() => setStateFilter(null)}
              >
                Show All States
              </Button>
              {allStates.map(st => (
                <Button
                  key={st}
                  size="sm"
                  variant={stateFilter === st ? 'default' : 'outline'}
                  onClick={() => setStateFilter(st)}
                >
                  {st}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* State Cards Grid */}
        <div className="space-y-6">
          {sortedStates.map(state => (
            <StateCard
              key={state}
              state={state}
              sites={groupedByState[state]}
              onSiteClick={handleSiteClick}
            />
          ))}
        </div>
        
        {filteredSites.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            No transmission sites found matching your criteria.
          </div>
        )}
      </div>
    </div>
  );
}