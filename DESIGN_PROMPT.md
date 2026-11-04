# Design prompt — make Neighborhood Perks look designed, not generated

Use this prompt for any visual change to the site.

---

You are redesigning the Neighborhood Perks marketing site (static HTML/CSS in this repo).
Keep what works: warm cream paper, deep green, coral, sunny yellow, the Fraunces + Figtree
pairing, the illustrated San Diego street, and the friendly, happy tone. The goal is a site that
looks like a good local designer made it for a real neighborhood business. Right now it looks
like it came out of an AI site builder.

## What makes it look AI-generated (remove all of these)

1. **Badge pills above the headline** ("● Carmel Valley · Torrey Highlands · San Diego"). Delete it.
2. **Eyebrow labels on every section** ("— HOW IT WORKS", "— AVAILABLE NOW"): tiny uppercase
   tracked text with a dash. Let the heading do the work. Use one label at most, and only where it
   carries information.
3. **Floating glass cards over the hero art** ("Vetted local pros / Every provider screened by
   us"). They repeat the copy and are a template tell. Remove them.
4. **An icon in a tinted rounded square on every card** (home, users, tag, shield…). Use icons only
   where they help someone do something (phone, menu). Never as decoration on a heading.
5. **Three identical cards in a row, repeated section after section**, with giant faded
   "01 02 03" numerals. Vary the structure: a definition, a numbered list, rows, a plain
   paragraph, a form.
6. **The italic accent word in the headline** ("at a *neighborhood* price"), the most overused
   AI-hero move. Set the headline in one voice.
7. **A trust row of icon + three-word claims** under the buttons. Replace it with one plain,
   useful line (hours, phone).
8. **Pill buttons with arrow icons and colored glow shadows everywhere.** One primary style:
   modest radius, no glow, no arrow. Secondary actions are text links.
9. **Decorative effects with no job:** radial gradient blobs, ring shapes in corners, glassy
   blurred header, hover-lift cards, fade-up-on-scroll for every block, floating animation.
10. **Status tags with pulsing dots** ("● BOOKING NOW") on each card. The section heading
    already says it.
11. **Sparkle icons on chips** and pill toggles that hide a plain choice. Real checkboxes are
    friendlier and clearer.
12. **Green check circles as list bullets** on every list. Use simple bullets.
13. **Copy tells:** tidy taglines like "Three words, one simple idea.", "Ready when you are",
    "Good to know", "Enjoy the perk", "We'd love to hear from you."; every list in threes;
    words like "seamless" and "elevate"; questions answered with a fragment. Write like the
    owner talking to a neighbor over the fence: specific, plain, a little warm.

## What to do instead (keep it friendly)

- **Let the illustration carry the friendliness.** Make the street scene a wide panorama under
  the hero text, edge to edge inside the page width, with more houses, a dog walker and the van.
  That makes it the brand moment instead of a box beside the copy.
- **Typography does the hierarchy.** Big, confident Fraunces headings; comfortable Figtree body
  copy; real size contrast between levels. No all-caps labels.
- **Borrow from the neighborhood itself:** a dictionary definition of "perk" (the old site asked
  "What is in a Perk?"), a numbered list, a newsletter-style column, a plain sign-up form.
  Each section gets the form that fits its content.
- **Color with restraint:** cream ground, ink text, green as the main brand color, coral only
  for the main call to action and small accents, yellow only in the illustration and highlights.
- **Flat and quiet:** thin 1px rules to separate things instead of cards with borders and
  shadows. Use a card only where something really is a container (a form).
- **Vary the rhythm:** not every section centered, not every section the same height or
  structure. Some left-aligned, some full-width bands, some narrow text columns.
- **Motion only where it helps:** focus rings, menu open/close. Respect reduced motion.
- **Honesty:** no invented stats, testimonials, guarantees or provider counts. Only claims the
  business actually makes.

## Done when

- Nothing above the hero headline but the header.
- No eyebrow labels, no decorative icon badges, no floating cards, no glow shadows, no
  scroll animations, no gradient blobs.
- At least four different section structures on the homepage.
- It still looks friendly and happy: illustration, warm colors and kind copy all intact.
- It works at 390px wide with no sideways scroll, and every form still posts to Netlify.
