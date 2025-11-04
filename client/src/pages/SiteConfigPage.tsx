import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MapPin, Download, Upload, Edit, Plus, Trash2, Settings } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { snmpService } from '@/services/snmpService';
import { Switch } from '@/components/ui/switch';

interface TransmitterDevice {
  id: string;
  type: string;
  label: string;
  role: 'Active' | 'Backup' | 'Standby';
  channelName: string;
  frequency: string;
  oidOffset: string;
  ipAddress: string;
  templateId?: string;
  pollInterval?: number;
  // Labeled OIDs for key transmitter parameters
  statusOid?: string;
  channelNameOid?: string;
  frequencyOid?: string;
  forwardPowerOid?: string;
  reflectPowerOid?: string;
  remoteStatusOid?: string;
}

interface SiteConfig {
  id?: string;
  name: string;
  location: string; // stored as "STATE, District" for now
  state?: string;
  district?: string;
  description: string;
  latitude: string;
  longitude: string;
  technician: string;
  phone: string;
  email: string;
  transmitters: TransmitterDevice[];
}

// Shape of site objects returned from the database/service layer
interface ContactInfo {
  technician?: string;
  phone?: string;
  email?: string;
}

interface DbSite {
  id: string;
  name: string;
  location?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  address?: string | null;
  contactInfo?: ContactInfo | null;
  isActive?: boolean | null;
}

export default function SiteConfigPage() {
  const OID_TEMPLATES: { id: string; name: string; oids: string[] }[] = [
    {
      id: 'standard-mib',
      name: 'Elenos ETG5000 - Standard MIB',
      oids: [
        '1.3.6.1.2.1.1.1.0', // sysDescr
        '1.3.6.1.2.1.1.3.0', // sysUpTime
        '1.3.6.1.2.1.1.5.0', // sysName
      ],
    },
    {
      id: 'production-mib',
      name: 'Elenos ETG5000 - Production MIB',
      oids: [
        '1.3.6.1.4.1.31946.4.2.6.10.1', // Forward Power
        '1.3.6.1.4.1.31946.4.2.6.10.2', // Reflected Power
        '1.3.6.1.4.1.31946.4.2.6.10.14', // Transmission Frequency (tens of kHz)
        '1.3.6.1.4.1.31946.4.2.6.10.12', // On Air Status
      ],
    },
  ];
  const [selectedSite, setSelectedSite] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [originalConfig, setOriginalConfig] = useState<SiteConfig | null>(null);
  const [sites, setSites] = useState<DbSite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  
  // Default empty site configuration
  const defaultSiteConfig: SiteConfig = {
    name: '',
    location: '',
    state: '',
    district: '',
    description: '',
    latitude: '',
    longitude: '',
    technician: '',
    phone: '',
    email: '',
    transmitters: []
  };

  const [siteConfig, setSiteConfig] = useState<SiteConfig>(defaultSiteConfig);

  const loadSiteTransmitters = async (siteId: string): Promise<TransmitterDevice[]> => {
    try {
      const txs = await snmpService.getTransmitters();
      const siteTxs = (txs || []).filter((t: any) => t.siteId === siteId);
      const mapOidsToLabels = (oids: string[]): Partial<TransmitterDevice> => {
        const safe = Array.isArray(oids) ? oids.filter((s) => typeof s === 'string') : [];
        const findBySuffix = (suffix: string) => safe.find((o) => o.endsWith(suffix) || o.includes(suffix));
        const statusOid = findBySuffix('.10.12');
        const channelNameOid = findBySuffix('1.5.0'); // sysName often ends with 1.5.0
        const frequencyOid = findBySuffix('.10.14') || findBySuffix('.1.1.2');
        const forwardPowerOid = findBySuffix('.10.1');
        const reflectPowerOid = findBySuffix('.10.2');
        const remoteStatusOid = findBySuffix('.10.4');
        const oidOffset = safe.length > 0 ? safe[0] : '';
        return {
          statusOid,
          channelNameOid,
          frequencyOid,
          forwardPowerOid,
          reflectPowerOid,
          remoteStatusOid,
          oidOffset,
        };
      };

      return siteTxs.map((t: any) => {
        const labeled = mapOidsToLabels(t.oids);
        return {
          id: t.id,
          type: 'FM Transmitter',
          label: t.label || t.name || 'Transmitter',
          role: t.status === 'active' ? 'Active' : (t.status === 'standby' ? 'Standby' : 'Backup'),
          channelName: '',
          frequency: typeof t.frequency === 'number' ? String(t.frequency) : (t.frequency || ''),
          ipAddress: t.snmpHost || '',
          templateId: undefined,
          pollInterval: t.pollInterval || 10000,
          statusOid: labeled.statusOid || '',
          channelNameOid: labeled.channelNameOid || '',
          frequencyOid: labeled.frequencyOid || '',
          forwardPowerOid: labeled.forwardPowerOid || '',
          reflectPowerOid: labeled.reflectPowerOid || '',
          remoteStatusOid: labeled.remoteStatusOid || '',
          oidOffset: labeled.oidOffset || '',
        } as TransmitterDevice;
      });
    } catch (e) {
      console.error('Failed to load transmitters for site', siteId, e);
      return [];
    }
  };

  // Load sites from database
  useEffect(() => {
    const loadSites = async () => {
      try {
        setIsLoading(true);
        const sitesData = await snmpService.getSites();
        setSites(sitesData);
      } catch (error) {
        console.error('Failed to load sites:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadSites();
  }, []);

  // Initialize original config when component mounts or site changes
  React.useEffect(() => {
    if (!isEditing) {
      setOriginalConfig({ ...siteConfig });
    }
  }, [selectedSite, isEditing]);

  const handleInputChange = (field: keyof SiteConfig, value: string) => {
    // Special handling for state/district to compose location
    if (field === 'state') {
      setSiteConfig(prev => {
        const newState = value;
        const composedLocation = newState && prev.district ? `${newState}, ${prev.district}` : newState || prev.district || '';
        return { ...prev, state: newState, location: composedLocation };
      });
    } else if (field === 'district') {
      setSiteConfig(prev => {
        const newDistrict = value;
        const composedLocation = prev.state && newDistrict ? `${prev.state}, ${newDistrict}` : prev.state || newDistrict || '';
        return { ...prev, district: newDistrict, location: composedLocation };
      });
    } else if (field === 'location') {
      // If user edits raw location, attempt to split into state/district
      const [st, dist] = value.split(',').map(s => s?.trim()).filter(Boolean);
      setSiteConfig(prev => ({ ...prev, location: value, state: st ?? prev.state ?? '', district: dist ?? prev.district ?? '' }));
    } else {
      setSiteConfig(prev => ({
        ...prev,
        [field]: value
      }));
    }
    setHasUnsavedChanges(true);
  };

  const handleTransmitterChange = (index: number, field: keyof TransmitterDevice, value: string | undefined) => {
    setSiteConfig(prev => ({
      ...prev,
      transmitters: prev.transmitters.map((tx, i) => 
        i === index 
          ? (
            field === 'templateId'
              ? { ...tx, templateId: value }
              : { ...tx, [field]: value as string }
            )
          : tx
      )
    }));
    setHasUnsavedChanges(true);
  };

  const addTransmitter = () => {
    const newTransmitter: TransmitterDevice = {
      id: `tmp-${Date.now()}`,
      type: 'FM Transmitter',
      label: `TX ${siteConfig.transmitters.length + 1}`,
      role: 'Active',
      channelName: '',
      frequency: '',
      oidOffset: '',
      ipAddress: '',
      templateId: undefined,
      pollInterval: 10000,
      statusOid: '',
      channelNameOid: '',
      frequencyOid: '',
      forwardPowerOid: '',
      reflectPowerOid: '',
      remoteStatusOid: '',
    };
    
    setSiteConfig(prev => ({
      ...prev,
      transmitters: [...prev.transmitters, newTransmitter]
    }));
    setHasUnsavedChanges(true);
  };

  const removeTransmitter = (index: number) => {
    setSiteConfig(prev => ({
      ...prev,
      transmitters: prev.transmitters.filter((_, i) => i !== index)
    }));
    setHasUnsavedChanges(true);
  };

  const handleSave = async () => {
    try {
      if (isCreatingNew) {
        // Create new site
        const newSite = await snmpService.createSite({
          name: siteConfig.name,
          location: siteConfig.location || [siteConfig.state, siteConfig.district].filter(Boolean).join(', '),
          latitude: parseFloat(siteConfig.latitude) || 0,
          longitude: parseFloat(siteConfig.longitude) || 0,
          address: siteConfig.description,
          contactInfo: {
            technician: siteConfig.technician,
            phone: siteConfig.phone,
            email: siteConfig.email
          },
          isActive: true
        });
        
        // Add the new site to the sites list
        setSites(prev => [...prev, newSite]);
        setSelectedSite(newSite.id);
        setIsCreatingNew(false);
        // Persist transmitters for the new site
        if (siteConfig.transmitters.length > 0) {
          const siteId = newSite.id;
          const updatedTransmitters = [...siteConfig.transmitters];

          for (let i = 0; i < updatedTransmitters.length; i++) {
            const tx = updatedTransmitters[i];
            const template = tx.templateId ? OID_TEMPLATES.find(t => t.id === tx.templateId) : undefined;
            const customOids = [
              tx.statusOid,
              tx.channelNameOid,
              tx.frequencyOid,
              tx.forwardPowerOid,
              tx.reflectPowerOid,
              tx.remoteStatusOid,
            ].filter((v): v is string => !!v && v.trim().length > 0);
            const oids = template
              ? [...template.oids, ...customOids]
              : (customOids.length > 0 ? customOids : (tx.oidOffset ? [tx.oidOffset] : []));

            const payload = {
              siteId,
              name: tx.label || 'Transmitter',
              displayLabel: tx.label || undefined,
              frequency: tx.frequency ? parseFloat(tx.frequency) : 0,
              power: 0,
              status: tx.role === 'Active' ? 'active' : tx.role === 'Standby' ? 'standby' : 'offline',
              snmpHost: tx.ipAddress || '127.0.0.1',
              snmpPort: 161,
              snmpCommunity: 'public',
              snmpVersion: 1,
              oids,
              pollInterval: tx.pollInterval || 30000,
              isActive: true,
            };

            const created = await snmpService.createTransmitter(payload);
            if (created && created.id) {
              updatedTransmitters[i] = { ...tx, id: created.id };
            }
          }

          setSiteConfig(prev => ({ ...prev, transmitters: updatedTransmitters }));
        }

        alert('Site and transmitters created successfully!');
      } else {
        if (!selectedSite) {
          alert('No site selected to update');
          return;
        }

        const updates = {
          name: siteConfig.name,
          location: siteConfig.location || [siteConfig.state, siteConfig.district].filter(Boolean).join(', '),
          latitude: siteConfig.latitude ? parseFloat(siteConfig.latitude) : null,
          longitude: siteConfig.longitude ? parseFloat(siteConfig.longitude) : null,
          address: siteConfig.description,
          contactInfo: {
            technician: siteConfig.technician,
            phone: siteConfig.phone,
            email: siteConfig.email
          },
        };

        const updatedSite = await snmpService.updateSite(selectedSite, updates);

        // Persist transmitters for existing site (create or update)
        if (siteConfig.transmitters.length > 0) {
          const siteId = selectedSite;
          const updatedTransmitters = [...siteConfig.transmitters];

          for (let i = 0; i < updatedTransmitters.length; i++) {
            const tx = updatedTransmitters[i];
            const template = tx.templateId ? OID_TEMPLATES.find(t => t.id === tx.templateId) : undefined;
            const customOids = [
              tx.statusOid,
              tx.channelNameOid,
              tx.frequencyOid,
              tx.forwardPowerOid,
              tx.reflectPowerOid,
              tx.remoteStatusOid,
            ].filter((v): v is string => !!v && v.trim().length > 0);
            const oids = template
              ? [...template.oids, ...customOids]
              : (customOids.length > 0 ? customOids : (tx.oidOffset ? [tx.oidOffset] : []));

            const payload = {
              siteId,
              name: tx.label || 'Transmitter',
              displayLabel: tx.label || undefined,
              frequency: tx.frequency ? parseFloat(tx.frequency) : 0,
              power: 0,
              status: tx.role === 'Active' ? 'active' : tx.role === 'Standby' ? 'standby' : 'offline',
              snmpHost: tx.ipAddress || '127.0.0.1',
              snmpPort: 161,
              snmpCommunity: 'public',
              snmpVersion: 1,
              oids,
              pollInterval: tx.pollInterval || 30000,
              isActive: true,
            };

            if (tx.id && !tx.id.startsWith('tmp-')) {
              await snmpService.updateTransmitter(tx.id, payload);
            } else {
              const created = await snmpService.createTransmitter(payload);
              if (created && created.id) {
                updatedTransmitters[i] = { ...tx, id: created.id };
              }
            }
          }

          // Delete transmitters that were removed from the configuration
          if (originalConfig && Array.isArray(originalConfig.transmitters)) {
            const originalIds = originalConfig.transmitters
              .map((t) => t.id)
              .filter((id): id is string => !!id && !id.startsWith('tmp-'));
            const currentIds = updatedTransmitters
              .map((t) => t.id)
              .filter((id): id is string => !!id && !id.startsWith('tmp-'));
            const removedIds = originalIds.filter((id) => !currentIds.includes(id));

            for (const id of removedIds) {
              try {
                await snmpService.deleteTransmitter(id);
              } catch (err) {
                console.error('Failed to delete transmitter', id, err);
              }
            }
          }

          setSiteConfig(prev => ({ ...prev, transmitters: updatedTransmitters }));
        }
        
        // Update local sites list
        setSites(prev => prev.map(site => site.id === updatedSite.id ? updatedSite : site));
        alert('Changes saved successfully!');
      }
      
      setIsEditing(false);
      setHasUnsavedChanges(false);
      setOriginalConfig({ ...siteConfig });
    } catch (error) {
      console.error('Failed to save site:', error);
      alert('Failed to save site. Please try again.');
    }
  };

  const handleCancel = () => {
    if (hasUnsavedChanges) {
      const confirmCancel = window.confirm('You have unsaved changes. Are you sure you want to cancel?');
      if (!confirmCancel) return;
    }
    
    if (isCreatingNew) {
      // Cancel creating new site
      setIsCreatingNew(false);
      setSelectedSite(null);
      setSiteConfig(defaultSiteConfig);
    } else {
      // Restore original configuration
      if (originalConfig) {
        setSiteConfig({ ...originalConfig });
      }
    }
    
    setIsEditing(false);
    setHasUnsavedChanges(false);
  };

  // Toggle site monitoring state (isActive)
  const toggleSiteActive = async (siteId: string, isActive: boolean) => {
    try {
      const updated = await snmpService.updateSite(siteId, { isActive });
      setSites(prev => prev.map(s => (s.id === siteId ? updated : s)));
    } catch (error) {
      console.error('Failed to update site monitoring state:', error);
      alert('Failed to update site monitoring state.');
    }
  };

  const handleExport = () => {
    // Export empty configuration template since no sites are configured
    const emptyConfig = {
      sites: [],
      message: "No sites configured. This is an empty configuration template."
    };
    const dataStr = JSON.stringify(emptyConfig, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = 'site-configuration.json';
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    console.log('Export completed');
  };

  const handleImport = () => {
    // TODO: Implement import functionality
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          try {
            const importedData = JSON.parse(e.target?.result as string);
            console.log('Imported data:', importedData);
            alert('Import functionality will be implemented in the next version');
          } catch (error) {
            alert('Invalid JSON file');
          }
        };
        reader.readAsText(file);
      }
    };
    
    input.click();
  };

  const handleAddSite = () => {
    // Check if there are unsaved changes
    if (hasUnsavedChanges) {
      const confirmDiscard = window.confirm('You have unsaved changes. Are you sure you want to discard them and create a new site?');
      if (!confirmDiscard) return;
    }
    
    // Set up for creating a new site
    setIsCreatingNew(true);
    setIsEditing(true);
    setSelectedSite(null);
    setSiteConfig(defaultSiteConfig);
    setOriginalConfig(null);
    setHasUnsavedChanges(false);
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'operational': return 'bg-green-500/20 text-green-400 border-green-500/30';
      case 'warning': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
      case 'error': return 'bg-red-500/20 text-red-400 border-red-500/30';
      case 'inactive': return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
      default: return 'bg-gray-500/20 text-gray-400 border-gray-500/30';
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">FM Transmitter Management</h1>
            <p className="text-gray-400">Configure and monitor FM transmitter sites</p>
          </div>
        </div>

      {/* Page Controls - Full Width */}
      <div className="space-y-3 mb-6">
        <div className="flex items-center gap-2">
          <MapPin className="w-5 h-5" />
          <h2 className="text-lg font-semibold">Site Configuration</h2>
        </div>
        <p className="text-sm text-gray-400">
          Manage transmitter sites and their SNMP connection settings
        </p>
        <div className="flex flex-wrap gap-2">
          <Button 
            size="sm" 
            variant="outline" 
            className="border-gray-600 text-gray-300 hover:bg-gray-700"
            onClick={handleExport}
          >
            <Download className="w-4 h-4 mr-1" />
            Export
          </Button>
          <Button 
            size="sm" 
            variant="outline" 
            className="border-gray-600 text-gray-300 hover:bg-gray-700"
            onClick={handleImport}
          >
            <Upload className="w-4 h-4 mr-1" />
            Import
          </Button>
          <Button 
            size="sm" 
            className="bg-blue-500 hover:bg-blue-600"
            onClick={handleAddSite}
          >
            <Plus className="w-4 h-4 mr-1" />
            Add Site
          </Button>
        </div>

        {/* State filter chips - Full Width */}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={stateFilter === null ? 'default' : 'outline'}
            onClick={() => setStateFilter(null)}
          >
            All States
          </Button>
          {Array.from(new Set(sites.map(s => (s.location || '').split(',')[0].trim())))
            .filter(st => st && st.length > 0)
            .sort()
            .map((st) => (
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
      </div>

      <div className="flex gap-6">
        {/* Left Panel - Site List */}
        <div className="w-80 space-y-4">
          <div className="space-y-2">
            {isLoading ? (
              <Card className="bg-gray-800/50 border-gray-700">
                <CardContent className="p-4 text-center">
                  <p className="text-gray-400 text-sm">Loading sites...</p>
                </CardContent>
              </Card>
            ) : sites.length === 0 ? (
              <Card className="bg-gray-800/50 border-gray-700">
                <CardContent className="p-4 text-center">
                  <p className="text-gray-400 text-sm">No sites configured</p>
                  <p className="text-gray-500 text-xs mt-1">Click "Add Site" to create your first site</p>
                </CardContent>
              </Card>
            ) : (
              <>
                {(stateFilter ? sites.filter(s => (s.location || '').split(',')[0].trim() === stateFilter) : sites).map((site) => (
                  <Card 
                    key={site.id}
                    className={`cursor-pointer transition-colors ${
                      selectedSite === site.id 
                        ? 'bg-blue-500/20 border-blue-500/50' 
                        : 'bg-gray-800/50 border-gray-700 hover:bg-gray-800/70'
                    }`}
                    onClick={() => {
                      if (!isEditing || !hasUnsavedChanges || window.confirm('You have unsaved changes. Are you sure you want to switch sites?')) {
                        setSelectedSite(site.id);
                        setIsCreatingNew(false);
                        // Load site configuration
                        (async () => {
                          const txDevices = await loadSiteTransmitters(site.id);
                          const config: SiteConfig = {
                            id: site.id,
                            name: site.name || '',
                            location: site.location || '',
                            state: (site.location || '').split(',')[0]?.trim() || '',
                            district: (site.location || '').split(',')[1]?.trim() || '',
                            description: site.address || '',
                            latitude: site.latitude?.toString() || '',
                            longitude: site.longitude?.toString() || '',
                            technician: site.contactInfo?.technician || '',
                            phone: site.contactInfo?.phone || '',
                            email: site.contactInfo?.email || '',
                            transmitters: txDevices,
                          };
                          setSiteConfig(config);
                          setOriginalConfig({ ...config });
                        })();
                        setIsEditing(false);
                        setHasUnsavedChanges(false);
                      }
                    }}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <h3 className="font-medium text-sm">{site.name}</h3>
                        <div className="flex gap-1">
                          {/* Removed redundant power button; monitoring is controlled via the toggle switch */}
                          <Button 
                            type="button"
                            size="sm" 
                            variant="ghost" 
                            className="h-6 w-6 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (selectedSite === site.id) {
                                setIsEditing(true);
                              }
                            }}
                          >
                            <Edit className="w-3 h-3" />
                          </Button>
                          <Button 
                            type="button"
                            size="sm" 
                            variant="ghost" 
                            className="h-6 w-6 p-0 text-red-400"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!site.id) return;
                              const confirmDelete = window.confirm('Delete this site and all related data?');
                              if (!confirmDelete) return;

                              try {
                                const ok = await snmpService.deleteSite(site.id);
                                if (!ok) {
                                  alert('Failed to delete site.');
                                  return;
                                }
                                // Remove from local list
                                setSites(prev => prev.filter(s => s.id !== site.id));

                                // If deleting the selected site, clear selection and form
                                if (selectedSite === site.id) {
                                  setSelectedSite(null);
                                  setIsCreatingNew(false);
                                  setSiteConfig(defaultSiteConfig);
                                  setOriginalConfig(null);
                                  setIsEditing(false);
                                  setHasUnsavedChanges(false);
                                }
                              } catch (err) {
                                console.error('Error deleting site:', err);
                                alert('Error deleting site.');
                              }
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-gray-400 mb-2">{site.location}</p>
                      
                      <div className="space-y-2">
                        <div className="text-xs">
                          <span className="text-gray-400">Status</span>
                          <div className="text-gray-300 flex items-center gap-2">
                            <Badge variant={site.isActive ? "default" : "secondary"} className="text-xs">
                              {site.isActive ? "Active" : "Inactive"}
                            </Badge>
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              <span className="text-gray-400">Monitor</span>
                              <Switch
                                checked={!!site.isActive}
                                onCheckedChange={(checked) => toggleSiteActive(site.id, checked)}
                              />
                            </div>
                          </div>
                        </div>
                        
                        <div className="text-xs">
                          <span className="text-gray-400">Coordinates</span>
                          <div className="text-gray-300">{site.latitude}, {site.longitude}</div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </>
            )}
          </div>
        </div>

        {/* Right Panel - Configuration Form */}
        <div className="flex-1">
          {selectedSite || isCreatingNew ? (
            <Card className="bg-gray-800/50 border-gray-700">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">
                    {isCreatingNew ? 'Create New Site' : 'Site Configuration'}
                  </CardTitle>
                  <div className="flex gap-2">
                    {!isEditing ? (
                      <Button 
                        type="button"
                        size="sm" 
                        onClick={() => setIsEditing(true)}
                        className="bg-blue-500 hover:bg-blue-600"
                      >
                        <Edit className="w-4 h-4 mr-1" />
                        Edit
                      </Button>
                    ) : (
                      <>
                        <Button 
                          type="button"
                          size="sm" 
                          variant="outline" 
                          onClick={handleCancel}
                          className="border-gray-600 text-gray-300"
                        >
                          Cancel
                        </Button>
                        <Button 
                          type="button"
                          size="sm" 
                          onClick={handleSave}
                          className="bg-green-500 hover:bg-green-600"
                          disabled={isCreatingNew ? !siteConfig.name.trim() : !hasUnsavedChanges}
                        >
                          {isCreatingNew ? 'Create Site' : 'Save Changes'}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Site Information */}
                <div className="space-y-4">
                  <h3 className="text-md font-semibold border-b border-gray-700 pb-2">Site Information</h3>
                  
                  {!isCreatingNew && selectedSite && (
                    <div className="flex items-center gap-3">
                      <Label htmlFor="monitoringToggle">Monitoring</Label>
                      <Switch
                        id="monitoringToggle"
                        checked={!!sites.find(s => s.id === selectedSite)?.isActive}
                        onCheckedChange={(checked) => toggleSiteActive(selectedSite!, checked)}
                      />
                    </div>
                  )}
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="siteName">Site Name</Label>
                      <Input
                        id="siteName"
                        value={siteConfig.name}
                        onChange={(e) => handleInputChange('name', e.target.value)}
                        disabled={!isEditing}
                        className="bg-gray-700 border-gray-600"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="state">State</Label>
                      <Input
                        id="state"
                        value={siteConfig.state ?? ''}
                        onChange={(e) => handleInputChange('state', e.target.value)}
                        disabled={!isEditing}
                        className="bg-gray-700 border-gray-600"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="district">District</Label>
                      <Input
                        id="district"
                        value={siteConfig.district ?? ''}
                        onChange={(e) => handleInputChange('district', e.target.value)}
                        disabled={!isEditing}
                        className="bg-gray-700 border-gray-600"
                      />
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      value={siteConfig.description}
                      onChange={(e) => handleInputChange('description', e.target.value)}
                      disabled={!isEditing}
                      className="bg-gray-700 border-gray-600"
                      rows={3}
                    />
                  </div>
                  
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="latitude">Latitude</Label>
                      <Input
                        id="latitude"
                        value={siteConfig.latitude}
                        onChange={(e) => handleInputChange('latitude', e.target.value)}
                        disabled={!isEditing}
                        className="bg-gray-700 border-gray-600"
                        placeholder="e.g., 3.1390"
                      />
                    </div>
                    
                    <div className="space-y-2">
                      <Label htmlFor="longitude">Longitude</Label>
                      <Input
                        id="longitude"
                        value={siteConfig.longitude}
                        onChange={(e) => handleInputChange('longitude', e.target.value)}
                        disabled={!isEditing}
                        className="bg-gray-700 border-gray-600"
                        placeholder="e.g., 101.6869"
                      />
                    </div>
                  </div>
                </div>

                {/* Contact Information */}
                <div className="space-y-4">
                  <h3 className="text-md font-semibold border-b border-gray-700 pb-2">Contact Information</h3>
                  
                  <div className="grid grid-cols-1 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="technician">Site Technician</Label>
                      <Input
                        id="technician"
                        value={siteConfig.technician}
                        onChange={(e) => handleInputChange('technician', e.target.value)}
                        disabled={!isEditing}
                        className="bg-gray-700 border-gray-600"
                      />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="phone">Phone Number</Label>
                        <Input
                          id="phone"
                          value={siteConfig.phone}
                          onChange={(e) => handleInputChange('phone', e.target.value)}
                          disabled={!isEditing}
                          className="bg-gray-700 border-gray-600"
                        />
                      </div>
                      
                      <div className="space-y-2">
                        <Label htmlFor="email">Email Address</Label>
                        <Input
                          id="email"
                          type="email"
                          value={siteConfig.email}
                          onChange={(e) => handleInputChange('email', e.target.value)}
                          disabled={!isEditing}
                          className="bg-gray-700 border-gray-600"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Transmitter Configuration */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-md font-semibold border-b border-gray-700 pb-2">Transmitter Configuration</h3>
                    {isEditing && (
                      <Button 
                        type="button"
                        size="sm" 
                        onClick={addTransmitter}
                        className="bg-green-500 hover:bg-green-600"
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        Add Transmitter
                      </Button>
                    )}
                  </div>
                  
                  {siteConfig.transmitters.length === 0 ? (
                    <div className="text-center py-8 text-gray-400">
                      <p>No transmitters configured</p>
                      {isEditing && (
                        <p className="text-sm mt-1">Click "Add Transmitter" to configure your first transmitter</p>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {siteConfig.transmitters.map((transmitter, index) => (
                        <Card key={transmitter.id} className="bg-gray-700/50 border-gray-600">
                          <CardContent className="p-4">
                            <div className="flex items-center justify-between mb-4">
                              <h4 className="font-medium">Transmitter {index + 1}</h4>
                              {isEditing && (
                                <Button 
                                  type="button"
                                  size="sm" 
                                  variant="ghost" 
                                  onClick={() => removeTransmitter(index)}
                                  className="text-red-400 hover:text-red-300"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </Button>
                              )}
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <Label>Type</Label>
                                <Select 
                                  value={transmitter.type} 
                                  onValueChange={(value) => handleTransmitterChange(index, 'type', value)}
                                  disabled={!isEditing}
                                >
                                  <SelectTrigger className="bg-gray-600 border-gray-500">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="FM Transmitter">FM Transmitter</SelectItem>
                                    <SelectItem value="AM Transmitter">AM Transmitter</SelectItem>
                                    <SelectItem value="Digital Transmitter">Digital Transmitter</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              
                              <div className="space-y-2">
                                <Label>Label</Label>
                                <Input
                                  value={transmitter.label}
                                  onChange={(e) => handleTransmitterChange(index, 'label', e.target.value)}
                                  disabled={!isEditing}
                                  className="bg-gray-600 border-gray-500"
                                />
                              </div>
                              
                              <div className="space-y-2">
                                <Label>Role</Label>
                                <Select 
                                  value={transmitter.role} 
                                  onValueChange={(value) => handleTransmitterChange(index, 'role', value as 'Active' | 'Backup' | 'Standby')}
                                  disabled={!isEditing}
                                >
                                  <SelectTrigger className="bg-gray-600 border-gray-500">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="Active">Active</SelectItem>
                                    <SelectItem value="Backup">Backup</SelectItem>
                                    <SelectItem value="Standby">Standby</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                              
                              <div className="space-y-2">
                                <Label>Channel Name</Label>
                                <Input
                                  value={transmitter.channelName}
                                  onChange={(e) => handleTransmitterChange(index, 'channelName', e.target.value)}
                                  disabled={!isEditing}
                                  className="bg-gray-600 border-gray-500"
                                />
                              </div>
                              
                              <div className="space-y-2">
                                <Label>Frequency (MHz)</Label>
                                <Input
                                  value={transmitter.frequency}
                                  onChange={(e) => handleTransmitterChange(index, 'frequency', e.target.value)}
                                  disabled={!isEditing}
                                  className="bg-gray-600 border-gray-500"
                                />
                              </div>
                              
                              <div className="space-y-2">
                                <Label>IP Address</Label>
                                <Input
                                  value={transmitter.ipAddress}
                                  onChange={(e) => handleTransmitterChange(index, 'ipAddress', e.target.value)}
                                  disabled={!isEditing}
                                  className="bg-gray-600 border-gray-500"
                                />
                              </div>
                            </div>

                            <div className="mt-4">
                              <Label>SNMP OID Offset</Label>
                              <Input
                                value={transmitter.oidOffset}
                                onChange={(e) => handleTransmitterChange(index, 'oidOffset', e.target.value)}
                                disabled={!isEditing}
                                className="bg-gray-600 border-gray-500 mt-2"
                                placeholder="e.g., 1.3.6.1.4.1.12345.1.1"
                              />
                            </div>

                            <div className="mt-4">
                              <Label>OID Template</Label>
                              <Select 
                                value={transmitter.templateId ?? undefined} 
                                onValueChange={(value) => handleTransmitterChange(index, 'templateId', value === 'none' ? undefined : value)}
                                disabled={!isEditing}
                              >
                                <SelectTrigger className="bg-gray-600 border-gray-500 mt-2">
                                  <SelectValue placeholder="Select a template (optional)" />
                                </SelectTrigger>
                              <SelectContent>
                                  <SelectItem value="none">None</SelectItem>
                                  {OID_TEMPLATES.map(t => (
                                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>

                            {/* New OID row */}
                            <div className="mt-4">
                              <Label>OID</Label>
                              <div className="grid grid-cols-3 gap-4 mt-2">
                                <div className="space-y-2">
                                  <Label>OID - Status</Label>
                                  <Input
                                    value={transmitter.statusOid || ''}
                                    onChange={(e) => handleTransmitterChange(index, 'statusOid', e.target.value)}
                                    disabled={!isEditing}
                                    className="bg-gray-600 border-gray-500"
                                    placeholder="e.g., 1.3.6.1.4.1.31946.4.2.6.10.12"
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>OID - Channel Name</Label>
                                  <Input
                                    value={transmitter.channelNameOid || ''}
                                    onChange={(e) => handleTransmitterChange(index, 'channelNameOid', e.target.value)}
                                    disabled={!isEditing}
                                    className="bg-gray-600 border-gray-500"
                                    placeholder="e.g., 1.3.6.1.2.1.1.5.0"
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>OID - Frequency</Label>
                                  <Input
                                    value={transmitter.frequencyOid || ''}
                                    onChange={(e) => handleTransmitterChange(index, 'frequencyOid', e.target.value)}
                                    disabled={!isEditing}
                                    className="bg-gray-600 border-gray-500"
                                    placeholder="e.g., 1.3.6.1.4.1.31946.4.2.6.10.14"
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>OID - Forward Power</Label>
                                  <Input
                                    value={transmitter.forwardPowerOid || ''}
                                    onChange={(e) => handleTransmitterChange(index, 'forwardPowerOid', e.target.value)}
                                    disabled={!isEditing}
                                    className="bg-gray-600 border-gray-500"
                                    placeholder="e.g., 1.3.6.1.4.1.31946.4.2.6.10.1"
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>OID - Reflect Power</Label>
                                  <Input
                                    value={transmitter.reflectPowerOid || ''}
                                    onChange={(e) => handleTransmitterChange(index, 'reflectPowerOid', e.target.value)}
                                    disabled={!isEditing}
                                    className="bg-gray-600 border-gray-500"
                                    placeholder="e.g., 1.3.6.1.4.1.31946.4.2.6.10.2"
                                  />
                                </div>
                                <div className="space-y-2">
                                  <Label>OID - Remote Status</Label>
                                  <Input
                                    value={transmitter.remoteStatusOid || ''}
                                    onChange={(e) => handleTransmitterChange(index, 'remoteStatusOid', e.target.value)}
                                    disabled={!isEditing}
                                    className="bg-gray-600 border-gray-500"
                                    placeholder="e.g., 1.3.6.1.4.1.31946.4.2.6.10.4"
                                  />
                                </div>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="bg-gray-800/50 border-gray-700">
              <CardContent className="p-8 text-center">
                <MapPin className="w-12 h-12 mx-auto text-gray-400 mb-4" />
                <h3 className="text-lg font-medium mb-2">No Site Selected</h3>
                <p className="text-gray-400 mb-4">Select a site from the left panel to configure its settings, or create a new site</p>
                <Button 
                  onClick={handleAddSite}
                  className="bg-blue-500 hover:bg-blue-600"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Create New Site
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}