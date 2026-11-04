// Inline SVG icons. Line icons use currentColor so they take the text color.
const line = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

module.exports = {
  mark: `<svg class="brand-mark" viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#1f4d36"/><path d="M9 19.5 20 10l11 9.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.5 17.5V30h15V17.5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linejoin="round"/><path d="M20 27.2s-4.2-2.5-4.2-5.4a2.1 2.1 0 0 1 4.2-.6 2.1 2.1 0 0 1 4.2.6c0 2.9-4.2 5.4-4.2 5.4Z" fill="#e0603a"/><circle cx="31.5" cy="9" r="3" fill="#f4b942"/></svg>`,

  check: line('<path d="M20 6 9 17l-5-5"/>'),
  shield: line('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>'),
  users: line('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  tag: line('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8Z"/><circle cx="7" cy="7" r="1.5"/>'),
  home: line('<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M9 22V12h6v10"/>'),
  calendar: line('<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>'),
  clock: line('<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>'),
  receipt: line('<path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2Z"/><path d="M8 9h8M8 13h6"/>'),
  sparkle: line('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
  heart: line('<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>'),
  phone: line('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>'),
  mail: line('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'),
  pin: line('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
  message: line('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  arrow: line('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  briefcase: line('<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>'),
  route: line('<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>'),
  star: line('<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/>'),

  facebook: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14 8.5V6.8c0-.8.5-1 1-1h2.2V2.1L14.2 2C10.9 2 10 4.4 10 6.3v2.2H7.8V12H10v10h4V12h2.9l.4-3.5Z"/></svg>`,
  instagram: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none"/></svg>`,

  // Service illustrations (larger, two-tone)
  "art-screen": `<svg viewBox="0 0 120 120" aria-hidden="true"><rect x="18" y="14" width="84" height="92" rx="8" fill="#fff" stroke="#2a6576" stroke-width="4"/><rect x="28" y="24" width="64" height="72" rx="3" fill="#cfe5ec"/><g stroke="#2a6576" stroke-opacity=".35" stroke-width="1.6"><path d="M28 33h64M28 42h64M28 51h64M28 60h64M28 69h64M28 78h64M28 87h64M37 24v72M46 24v72M55 24v72M64 24v72M73 24v72M82 24v72"/></g><path d="M60 24v72M28 60h64" stroke="#2a6576" stroke-width="4"/><circle cx="96" cy="96" r="16" fill="#e0603a"/><path d="m89 96 5 5 9-10" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  "art-walk": `<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="40" cy="20" r="9" fill="#1f4d36"/><path d="M40 30c-6 0-9 5-9 11v22l-5 34" fill="none" stroke="#1f4d36" stroke-width="8" stroke-linecap="round"/><path d="M33 64l12 33" stroke="#1f4d36" stroke-width="8" stroke-linecap="round"/><path d="M38 42l14 14" stroke="#1f4d36" stroke-width="6" stroke-linecap="round"/><path d="M52 56C64 62 70 70 78 72" fill="none" stroke="#e0603a" stroke-width="3" stroke-dasharray="1 0" stroke-linecap="round"/><path d="M76 74h22c4 0 7 3 7 7v3c0 2-2 4-4 4H80" fill="#f4b942"/><rect x="72" y="74" width="30" height="16" rx="8" fill="#f4b942"/><circle cx="104" cy="70" r="8" fill="#f4b942"/><path d="M107 63l4-6 1 9" fill="#c98a12"/><circle cx="106" cy="69" r="1.6" fill="#17261d"/><path d="M76 88v12M84 89v11M94 89v11M100 88v12" stroke="#c98a12" stroke-width="4" stroke-linecap="round"/><path d="M72 78c-6-2-8-8-6-12" fill="none" stroke="#f4b942" stroke-width="4" stroke-linecap="round"/><path d="M14 104h96" stroke="#2c6a4b" stroke-opacity=".3" stroke-width="3" stroke-linecap="round"/></svg>`,
  "art-sit": `<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M16 56 60 20l44 36" fill="none" stroke="#c24c28" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M26 50v52h68V50" fill="#fff" stroke="#c24c28" stroke-width="5" stroke-linejoin="round"/><g fill="#e0603a"><ellipse cx="60" cy="80" rx="13" ry="11"/><ellipse cx="44" cy="64" rx="5.5" ry="7"/><ellipse cx="54" cy="57" rx="5.5" ry="7"/><ellipse cx="66" cy="57" rx="5.5" ry="7"/><ellipse cx="76" cy="64" rx="5.5" ry="7"/></g><circle cx="98" cy="22" r="10" fill="#f4b942"/></svg>`,
};
