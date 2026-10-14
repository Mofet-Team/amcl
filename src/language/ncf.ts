// Reader for an LCN's Network Configuration File (NCF.WF on the system, often copied as NCF.XX).
// It is used for one thing: naming LCNs. The UCN numbers behind each LCN's NIMs identify which
// LCN a group of points belongs to.

export interface NetworkConfig {
  /** Display name: the folder holding `sys/NCF.XX` (as in `A/sys/NCF.XX`), else the descriptor. */
  name: string;
  descriptor?: string;
  /** UCN numbers of the LCN's NIMs. */
  ucns: Set<number>;
}

export function parseNcf(text: string, file: string): NetworkConfig | undefined {
  if (!/\{NETWORK CONFIGURATION FILE\}/.test(text)) return undefined;
  // NCF records are padded with NUL bytes.
  // eslint-disable-next-line no-control-regex
  const descriptor = /SYSTEM DESCRIPTOR\s*:\s*([^\r\n\x00]*)/.exec(text)?.[1].trim();
  const ucns = new Set([...text.matchAll(/UNIVERSAL CONTROL NETWORK\s*:\s*(\d+)/g)].map((m) => Number(m[1])));
  const folder = /([^\\/]+)[\\/]sys[\\/][^\\/]+$/i.exec(file)?.[1];
  return { name: folder ?? descriptor ?? file, descriptor, ucns };
}
