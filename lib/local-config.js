// Private, per-install behaviour that names real agents or programs. It lives under "local" in
// crew.config.json (never published) and defaults to nothing, so a fresh install behaves generically.
//   nightOnlyAgents    agent ids that only run 23:00-06:00; daytime hand-offs go to workspace/<id>/QUEUE.md
//   stopOnControlOff   { match: "<regex on agent id>", except: [ids] } agents stopped when Computer control goes off
//   keepAliveProcs     regex for process names always listed under an agent (Heavy programs panel)
//   keepPython         regex for python scripts the automation sweep must never kill
//   cleanupDirs        extra folders the nightly screenshot cleanup scans
//   defaultGroups      { agentId: "Group name" } sidebar groups used until the browser saves its own
//   serviceHints       [["ENV_VAR_PATTERN", "Service label"]] extra names for the Connections panel
//   machineNames       host names publish.js must never let into the public export
//   avatars            { agentId: [svg paths, [color1, color2]] } built-in drawings (data/avatar-extras.json also works)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read() {
  try {
    const l = JSON.parse(fs.readFileSync(path.join(ROOT, 'crew.config.json'), 'utf8')).local;
    return l && typeof l === 'object' ? l : {};
  } catch { return {}; }
}

function rx(src, flags = 'i') { try { return src ? new RegExp(src, flags) : null; } catch { return null; } }

function load() {
  const l = read();
  const stop = l.stopOnControlOff || {};
  return {
    nightOnlyAgents: Array.isArray(l.nightOnlyAgents) ? l.nightOnlyAgents.map(String) : [],
    stopOnControlOff: { match: stop.match ? String(stop.match) : '', except: Array.isArray(stop.except) ? stop.except.map(String) : [] },
    keepAliveProcs: l.keepAliveProcs ? String(l.keepAliveProcs) : '',
    keepPython: l.keepPython ? String(l.keepPython) : '',
    cleanupDirs: Array.isArray(l.cleanupDirs) ? l.cleanupDirs.map(String) : [],
    defaultGroups: l.defaultGroups && typeof l.defaultGroups === 'object' ? l.defaultGroups : {},
    serviceHints: (Array.isArray(l.serviceHints) ? l.serviceHints : []).map(([p, name]) => [rx(p), String(name)]).filter(([re]) => re),
    avatars: l.avatars && typeof l.avatars === 'object' ? l.avatars : {},
  };
}

const isNight = (d = new Date()) => d.getHours() >= 23 || d.getHours() < 6;
function stopsOnControlOff(local, id) {
  const re = rx(local.stopOnControlOff.match);
  return !!re && re.test(id) && !local.stopOnControlOff.except.includes(id);
}

module.exports = { load, rx, isNight, stopsOnControlOff };
