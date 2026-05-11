window.__PROTOCLAW_TAURI_BRIDGE__ = {
  available() {
    return true;
  },
  async invoke(command, payload = {}) {
    if (command === 'get_connected_agents') {
      const res = await fetch('/protoclaw/get_connected_agents');
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'get_prebuilt_agents') {
      const res = await fetch('/protoclaw/get_prebuilt_agents');
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'get_agents_status') {
      const res = await fetch('/protoclaw/get_agents_status');
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'start_agent') {
      const res = await fetch('/protoclaw/start_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'stop_agent') {
      const res = await fetch('/protoclaw/stop_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'restart_agent') {
      const res = await fetch('/protoclaw/restart_agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'select_empty_directory') {
      const res = await fetch('/protoclaw/select_empty_directory', {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'select_files') {
      const res = await fetch('/protoclaw/select_files', {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    if (command === 'select_directory') {
      const res = await fetch('/protoclaw/select_directory', {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }

    throw new Error(`Unsupported invoke command in web mode: ${command}`);
  },
};
