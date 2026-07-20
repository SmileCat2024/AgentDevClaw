import {
  sidebarDiagnosticWriter,
  recordSidebarDiagnosticEvent,
} from '../shared/sidebar-diagnostics.js';

export function setupSidebarDiagnosticsRoutes(app, express, options = {}) {
  const writer = options.writer || sidebarDiagnosticWriter;

  app.post('/protoclaw/sidebar_diagnostics/events', express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      if (!Array.isArray(req.body?.events)) {
        res.status(400).json({ error: 'events must be an array' });
        return;
      }
      const submitted = req.body.events.length;
      const accepted = await writer.append(req.body.events.slice(0, 50), {
        source: 'client',
        kind: 'operation_phase',
      });
      res.json({ ok: true, accepted, rejected: Math.max(0, submitted - accepted) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/protoclaw/sidebar_diagnostics/status', (_req, res) => {
    const status = writer.status();
    res.json({
      enabled: status.enabled,
      schemaVersion: status.schemaVersion,
      location: '.agentdev/AgentDevClaw/diagnostics/sidebar',
      fileName: 'sidebar-events.jsonl',
      maxFileBytes: status.maxFileBytes,
      retentionDays: status.retentionDays,
      maxArchivedFiles: status.maxArchivedFiles,
    });
  });

  if (writer === sidebarDiagnosticWriter) {
    void recordSidebarDiagnosticEvent({
      kind: 'system',
      operation: 'sidebar_diagnostics',
      phase: 'server_started',
      result: 'success',
    }, { source: 'server' });
  }
}
