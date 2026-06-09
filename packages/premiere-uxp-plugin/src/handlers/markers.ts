import type { AddMarkersParams, AddMarkersResult } from "@ppmcp/protocol";
import { BridgeError } from "../errors.js";
import {
  ppro,
  getActiveProject,
  resolveSequence,
  describeShape,
  withLockedAccess,
} from "./ppro.js";

export async function addMarkers(params: AddMarkersParams): Promise<AddMarkersResult> {
  const project = await getActiveProject();
  const sequence = await resolveSequence(project, params.sequenceId);

  const markersObj = await ppro.Markers.getMarkers(sequence);
  if (!markersObj) {
    throw new BridgeError(
      "PREMIERE_API_ERROR",
      `Markers API unavailable. ppro.Markers: ${describeShape(ppro.Markers)}`,
    );
  }

  let removed = 0;
  const existing: any[] = params.clearExisting ? (await markersObj.getMarkers()) ?? [] : [];

  // One transaction: clear (optional) + add all markers = a single undo step.
  await withLockedAccess(project, () => {
    project.executeTransaction((compound: any) => {
      for (const marker of existing) {
        compound.addAction(markersObj.createRemoveMarkerAction(marker));
        removed++;
      }
      for (const spec of params.markers) {
        const start = ppro.TickTime.createWithSeconds(spec.seconds);
        const duration = spec.durationSeconds
          ? ppro.TickTime.createWithSeconds(spec.durationSeconds)
          : ppro.TickTime.TIME_ZERO;
        compound.addAction(
          markersObj.createAddMarkerAction(
            spec.name ?? "",
            "Comment",
            start,
            duration,
            spec.comments ?? "",
          ),
        );
      }
    }, `MCP: add ${params.markers.length} marker(s)`);
  });

  // Colors can only be set on existing Marker objects — second pass, matched by time.
  const wantColor = params.markers.filter((m) => m.colorIndex !== undefined);
  if (wantColor.length > 0) {
    const all: any[] = (await markersObj.getMarkers()) ?? [];
    const withStarts = await Promise.all(
      all.map(async (m) => ({ m, start: (await m.getStart()).seconds as number })),
    );
    await withLockedAccess(project, () => {
      project.executeTransaction((compound: any) => {
        for (const spec of wantColor) {
          const hit = withStarts.find((x) => Math.abs(x.start - spec.seconds) < 0.02);
          if (hit) {
            compound.addAction(hit.m.createSetColorByIndexAction(spec.colorIndex));
          }
        }
      }, "MCP: marker colors");
    });
  }

  return { added: params.markers.length, removed };
}
