// Reproduces the user's Claude startup screen without trusting a real folder.
export const trustMenu = (cursor = 0) => [
  'C:\\Users\\zhouh',
  '',
  'Quick safety check: Is this a project you created or one you trust?',
  "If not, take a moment to review what's in this folder first.",
  '',
  "Claude Code'll be able to read, edit, and execute files here.",
  '',
  'Security guide',
  '',
  `${cursor === 0 ? '❯' : ' '} No, exit`,
  `${cursor === 1 ? '❯' : ' '} Yes, I trust this folder`,
  '',
  'Enter to confirm · Esc to cancel',
];
