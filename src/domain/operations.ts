import { HostmanError, belongs, ipKey, normalizeHost, resolveTarget, validate, type Group, type HostmanDocument, type Target } from './model.js';
import { candidates, parse, removeImported, serialize } from '../hosts/document.js';

export type Operation =
  | { kind: 'init' }
  | { kind: 'migrate'; groups: string[] }
  | { kind: 'add-group'; group: Group }
  | { kind: 'remove-group' | 'enable' | 'disable'; group: string }
  | { kind: 'add-host' | 'remove-host'; group: string; host: string }
  | { kind: 'use'; group: string; target: string }
  | { kind: 'target-add' | 'target-set'; group: string; target: Target }
  | { kind: 'target-remove'; group: string; target: string }
  | { kind: 'global-add' | 'global-set'; name: string; ip: string }
  | { kind: 'global-remove'; name: string }
  | { kind: 'repair'; group: string; strategy: 'restore' | 'keep'; ip?: string };
export function expandHost(group: string, value: string): string {
  const host = normalizeHost(value === '@' ? group : value.includes('.') ? value : `${value}.${group}`);
  if (!belongs(host,group)) throw new HostmanError(`${host} does not belong to ${group}.`);
  return host;
}
export function targetFrom(name: string, value: string): Target {
  return value.startsWith('@') ? { name, source: 'global', globalName: value.slice(1) } : { name, source: 'group', ip: value };
}
export function applyOperation(document: HostmanDocument, operation: Operation): { document: HostmanDocument; touched: Set<string> } {
  const doc: HostmanDocument = structuredClone(document), touched = new Set<string>();
  const group = (name: string): Group => { const g = doc.groups.find(x => x.name === name); if (!g) throw new HostmanError(`Unknown group ${name}.`); touched.add(name); return g; };
  switch (operation.kind) {
    case 'init': case 'migrate': break;
    case 'add-group':
      if (doc.groups.some(g => g.name === operation.group.name)) throw new HostmanError('Group already exists.');
      doc.groups.push(structuredClone(operation.group)); touched.add(operation.group.name); break;
    case 'remove-group': group(operation.group); doc.groups = doc.groups.filter(g => g.name !== operation.group); break;
    case 'enable': case 'disable': group(operation.group).enabled = operation.kind === 'enable'; break;
    case 'add-host': case 'remove-host': {
      const g = group(operation.group), host = expandHost(g.name,operation.host);
      if (operation.kind === 'add-host') {
        if (doc.groups.some(x => x.hosts.includes(host))) throw new HostmanError(`Hostname ${host} already exists.`);
        g.hosts.push(host);
      } else { if (!g.hosts.includes(host)) throw new HostmanError(`Unknown hostname ${host}.`); g.hosts = g.hosts.filter(h => h !== host); }
      break;
    }
    case 'use': { const g = group(operation.group); resolveTarget(doc,g,operation.target); g.activeTarget = operation.target; break; }
    case 'target-add': case 'target-set': {
      const g = group(operation.group), index = g.targets.findIndex(t => t.name === operation.target.name);
      if (operation.kind === 'target-add' && index >= 0) throw new HostmanError('Target already exists.');
      if (operation.kind === 'target-set' && index < 0) throw new HostmanError('Unknown target.');
      if (index < 0) g.targets.push(operation.target); else g.targets[index] = operation.target; break;
    }
    case 'target-remove': {
      const g = group(operation.group);
      if (g.activeTarget === operation.target) throw new HostmanError('Cannot remove the active target. Switch targets first.');
      if (!g.targets.some(t => t.name === operation.target)) throw new HostmanError('Unknown target.');
      g.targets = g.targets.filter(t => t.name !== operation.target); break;
    }
    case 'global-add': case 'global-set': {
      const index = doc.globals.findIndex(t => t.name === operation.name);
      if (operation.kind === 'global-add' && index >= 0) throw new HostmanError('Global target already exists.');
      if (operation.kind === 'global-set' && index < 0) throw new HostmanError('Unknown global target.');
      if (index < 0) doc.globals.push({ name: operation.name, ip: operation.ip }); else doc.globals[index].ip = operation.ip;
      for (const g of doc.groups) if (g.enabled && g.targets.some(t => t.name === g.activeTarget && t.source === 'global' && t.globalName === operation.name)) touched.add(g.name);
      break;
    }
    case 'global-remove': {
      const references = doc.groups.filter(g => g.targets.some(t => t.source === 'global' && t.globalName === operation.name));
      if (references.length) throw new HostmanError(`Cannot remove referenced global target ${operation.name}: ${references.map(g => g.name).join(', ')}.`);
      if (!doc.globals.some(t => t.name === operation.name)) throw new HostmanError('Unknown global target.');
      doc.globals = doc.globals.filter(t => t.name !== operation.name); break;
    }
    case 'repair': {
      const g = group(operation.group);
      if (operation.strategy === 'keep') {
        const target = g.targets.find(t => t.name === g.activeTarget);
        if (!target || target.source !== 'group') throw new HostmanError('Keep effective IP requires a group-owned active target. Repair shared globals explicitly.');
        if (!operation.ip) throw new HostmanError('Repair requires an effective IP.');
        target.ip = operation.ip;
      }
      break;
    }
    default: throw new HostmanError('Unsupported operation.');
  }
  const conflicts = validate(doc).filter(c => !c.group || touched.has(c.group));
  if (conflicts.length) throw new HostmanError(conflicts.map(c => c.message).join('\n'));
  return { document: doc, touched };
}
export function transform(text: string, operation: Operation): string {
  let parsed = parse(text);
  if (parsed.documentFatal) throw new HostmanError(parsed.conflicts.map(c => c.message).join('\n'));
  if (operation.kind === 'init') {
    if (parsed.conflicts.length) throw new HostmanError('Resolve managed conflicts before initialization.');
    return parsed.outer ? text : serialize(parsed,parsed.document,new Set());
  }
  if (operation.kind === 'migrate') {
    const found = candidates(parsed), chosen = found.filter(c => operation.groups.includes(c.group));
    for (const name of operation.groups) if (!found.some(c => c.group === name) && !parsed.document.groups.some(g => g.name === name)) throw new HostmanError(`No candidate or managed group ${name}.`);
    if (chosen.some(c => c.reason)) throw new HostmanError(chosen.filter(c => c.reason).map(c => `${c.group}: ${c.reason}`).join('\n'));
    if (!chosen.length) return text;
    const originalEol = parsed.eol;
    parsed = parse(removeImported(parsed,new Set(chosen.flatMap(c => c.hosts))));
    parsed.eol = originalEol;
    const doc = structuredClone(parsed.document);
    for (const candidate of chosen) {
      const g = doc.groups.find(g => g.name === candidate.group);
      if (g) g.hosts.push(...candidate.hosts);
      else doc.groups.push({ name: candidate.group, enabled: true, activeTarget: 'imported', targets: [{ name: 'imported', source: 'group', ip: candidate.ip }], hosts: candidate.hosts });
    }
    return checked(serialize(parsed,doc,new Set(chosen.map(c => c.group))),new Set(chosen.map(c => c.group)));
  }
  const affected = 'group' in operation ? typeof operation.group === 'string' ? operation.group : operation.group.name : undefined;
  if (operation.kind !== 'repair' && parsed.conflicts.some(c => !c.group || c.group === affected || (!affected && parsed.document.groups.some(g => g.name === c.group && g.targets.some(t => t.source === 'global' && 'name' in operation && t.globalName === operation.name))))) throw new HostmanError('Conflicted scope. Run hostman repair before mutation.');
  if (operation.kind === 'repair') {
    const group = parsed.groups.find(g => g.group.name === operation.group);
    if (!group) throw new HostmanError(`Unknown group ${operation.group}.`);
    if (parsed.conflicts.some(c => c.group === operation.group && c.type !== 'EffectiveIpConflict')) throw new HostmanError('This conflict requires manual structural repair.');
    if (operation.strategy === 'keep') {
      const ips = new Set(group.effective.map(r => ipKey(r.ip)));
      if (ips.size !== 1 || !operation.ip || !ips.has(ipKey(operation.ip))) throw new HostmanError('Keep requires one unambiguous effective IP.');
    }
  }
  const { document, touched } = applyOperation(parsed.document,operation);
  if (!parsed.outer) throw new HostmanError('No hostman section. Run hostman init or migrate first.');
  if (operation.kind !== 'repair' && JSON.stringify(document) === JSON.stringify(parsed.document) && [...touched].every(name => parsed.groups.find(g => g.group.name === name)?.status === 'CLEAN')) return text;
  return checked(serialize(parsed,document,touched),touched);
}
function checked(text: string, touched: Set<string>): string {
  const parsed = parse(text);
  const conflicts = parsed.conflicts.filter(c => parsed.documentFatal || !c.group || touched.has(c.group));
  if (conflicts.length) throw new HostmanError(conflicts.map(c => c.message).join('\n'));
  return text;
}
