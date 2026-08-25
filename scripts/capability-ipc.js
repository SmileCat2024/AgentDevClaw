/**
 * Capability IPC handler for the prebuilt agent runtime.
 *
 * Extracted from run-prebuilt-agent.js handleIPC so the registry transport
 * logic is unit-testable without booting a runtime process. The host-side
 * counterpart lives in server/routes/capability.js; both speak the
 * capability-result request/ack protocol.
 */

/**
 * Handle capability-invoke / capability-list-request session IPC.
 *
 * @param {object} session runtime session view: { agent, sessionId }
 * @param {object} msg IPC message ({ type, ref?, args?, entryPoint? })
 * @param {(payload: object) => void} reply sends the capability-result payload
 *   (caller adds type/requestId/sessionId envelope fields)
 */
export async function handleCapabilityIPC(session, msg, reply) {
  const agent = session?.agent;
  if (typeof agent?.invokeCapability !== 'function' || typeof agent?.getCapabilitySnapshot !== 'function') {
    reply({ ok: false, error: 'capability registry not available in this session' });
    return;
  }
  try {
    if (msg.type === 'capability-list-request') {
      const entryPoint = typeof msg.entryPoint === 'string' ? msg.entryPoint : 'slash';
      const commands = await agent.getCapabilitySnapshot({ entryPoint });
      reply({ ok: true, commands });
    } else {
      // Host-forwarded user triggers enter as the slash entry point; the
      // registry enforces the entryPoints contract from there.
      const result = await agent.invokeCapability(msg.ref, msg.args, 'slash');
      reply(result);
    }
  } catch (err) {
    reply({ ok: false, error: String(err?.message || err) });
  }
}
