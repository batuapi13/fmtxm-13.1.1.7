import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import TransmitterCard from './TransmitterCard';
import { useEffect, useState } from 'react';
import { snmpService } from '@/services/snmpService';
import StatusIndicator from './StatusIndicator';
import { MapPin, AlertTriangle, GripVertical } from 'lucide-react';
import type { SiteData, TransmitterData } from '@/types/dashboard';
import { extractAlarmsFromSites } from '@/utils/siteDataLoader';

// dnd-kit imports for grid-friendly sorting
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import { SortableContext, useSortable, arrayMove, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { restrictToParentElement } from '@dnd-kit/modifiers';

interface SiteCardProps {
  site: SiteData;
  onSiteClick?: (siteId: string) => void;
  alarms?: number; // Number of alarms for this specific site
}

function SortableTxCard({ transmitter, isActive }: { transmitter: TransmitterData; isActive: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({ id: transmitter.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    touchAction: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="h-full"
      // Prevent site-level click while dragging or clicking inside the item
      onPointerDown={(e) => e.stopPropagation()}
      {...attributes}
    >
      <TransmitterCard transmitter={transmitter} isActive={isActive} dragHandleRef={setActivatorNodeRef as any} dragHandleListeners={listeners} />
    </div>
  );
}

export default function SiteCard({ site, onSiteClick, alarms }: SiteCardProps) {
  // Calculate alarms for this site if not provided
  const siteAlarms = alarms ?? extractAlarmsFromSites([site]).length;
  const handleHeaderClick = () => {
    console.log(`Site header clicked: ${site.name}`);
    onSiteClick?.(site.id);
  };

  // Local reorderable list state
  const [orderedTx, setOrderedTx] = useState(site.transmitters);

  // Use MouseSensor and TouchSensor for better compatibility
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // Lower distance threshold to make dragging easier
      activationConstraint: { distance: 4 },
    })
  );

  // Keep local order in sync when parent site updates (e.g., metrics refresh)
  useEffect(() => {
    setOrderedTx(prev => {
      const next = site.transmitters;
      const prevIds = prev.map(t => t.id);
      const nextIds = next.map(t => t.id);
      const idsChanged = prevIds.length !== nextIds.length || prevIds.some(id => !nextIds.includes(id));

      if (idsChanged) {
        // Adopt new transmitters list when IDs change (added/removed)
        return next;
      }

      // Preserve local ordering; update transmitter content from parent
      const nextMap = new Map(next.map(t => [t.id, t] as const));
      return prev.map(t => {
        const updated = nextMap.get(t.id);
        return updated ? { ...t, ...updated } : t;
      });
    });
  }, [site.transmitters]);

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = orderedTx.findIndex((t) => t.id === active.id);
    const newIndex = orderedTx.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = arrayMove(orderedTx, oldIndex, newIndex);
    setOrderedTx(newOrder);

    // Persist new displayOrder based on index
    try {
      await Promise.all(newOrder.map((tx, idx) => snmpService.updateTransmitter(tx.id, { displayOrder: idx })));
    } catch (err) {
      console.error('Failed to persist transmitter order', err);
    }
  };

  return (
    <Card className="border-card-border hover-elevate">
      <CardHeader className="pb-4 cursor-pointer" onClick={handleHeaderClick}>
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold text-lg" data-testid={`site-name-${site.id}`}>
                {site.name}
              </h3>
              <StatusIndicator 
                status={site.overallStatus} 
                size="md" 
                animate={site.overallStatus === 'operational'}
              />
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <MapPin className="w-3 h-3" />
              <span data-testid="site-location">
                {site.location} ({site.coordinates.lat}, {site.coordinates.lng})
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <button
              className="cursor-grab p-1 rounded hover:bg-muted/40"
              aria-label="Drag site card"
              onClick={(e) => e.preventDefault()}
              title="Drag Site"
            >
              <GripVertical className="w-4 h-4 text-muted-foreground" />
            </button>
            {siteAlarms > 0 && (
              <Badge variant="destructive" className="flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                {siteAlarms}
              </Badge>
            )}
          </div>
        </div>
        
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Running TX:</span>
          <Badge variant="default" data-testid="active-transmitter-count">
            {site.runningActiveCount} of {site.activeTransmitterCount}
          </Badge>
          <span className="text-muted-foreground">Active Backups:</span>
          <Badge variant="secondary" data-testid="backup-transmitter-count">
            {site.runningBackupCount} of {site.backupTransmitterCount}
          </Badge>
        </div>
      </CardHeader>
      
      <CardContent className="space-y-4">
        <DndContext sensors={sensors} onDragEnd={handleDragEnd} modifiers={[restrictToParentElement]} collisionDetection={closestCenter}>
          <SortableContext items={orderedTx.map((t) => t.id)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-4 gap-2 items-stretch">
              {orderedTx.map((transmitter) => {
                // Correct Active/Standby logic - only transmitting units show as Active
                const isBackup = transmitter.type.includes('backup1') || transmitter.type.includes('backup2');
                const isActive = transmitter.isTransmitting && (!isBackup || (isBackup && Boolean(transmitter.takenOverFrom)));

                return (
                  <SortableTxCard key={transmitter.id} transmitter={transmitter} isActive={isActive} />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </CardContent>
    </Card>
  );
}