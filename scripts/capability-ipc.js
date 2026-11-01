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
export async function dispatchCapabilityRequest(session, msg) {
  const agent = session?.agent;
  if (typeof agent?.invokeCapability !== 'function' || typeof agent?.getCapabilitySnapshot !== 'function') {
    return { ok: false, error: 'capability registry not available in this session' };
  }
  try {
    if (msg.type === 'capability-list-request') {
      const entryPoint = typeof msg.entryPoint === 'string' ? msg.entryPoint : 'slash';
      return { ok: true, commands: await agent.getCapabilitySnapshot({ entryPoint }) };
    }
    // Host-forwarded user triggers enter as the slash entry point; the
    // registry enforces the entryPoints contract from there.
    return await agent.invokeCapability(msg.ref, msg.args, 'slash');
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

export async function handleCapabilityIPC(session, msg, reply) {
  reply(await dispatchCapabilityRequest(session, msg));
}
