// The comedian roster: who is who across every show, so the "By comedian" tab can put one person's
// sets together no matter how each tape happened to be named. Data only — the rules that apply it
// live in library.js, and test-library.mjs fails if any set tape in Drive can't be placed.
//
// Built 2026-10-22 from a full scan of the NSDS Drive (673 videos, 41 request/tracker sheets) and
// Neal's answers that day. Full names are only here where a sheet, a finished-clip filename or Neal
// gave one.
//
// Tapes are matched by their performer LABEL — what performerFrom() makes of the filename, e.g.
// "YanjaaW Set.mp4" -> "YanjaaW". Comparison ignores case, spaces and punctuation, and a trailing
// part marker (Neal2, NealPt2, Neal (Top), Neal Additional) is stripped before a second try, so a
// new show's "Neal4" needs no edit here.
//
// ADDING A COMEDIAN: add an entry. FIXING A NEW SHOW'S LABEL: if the label is unique, add it to that
// person's aliases; if it could mean more than one person (a bare "Dan"), add it under the show in
// SHOW_OVERRIDES instead. Never add an AMBIGUOUS label as an alias.

/** key: stable slug, used in ?comedian= links — don't rename one that has shipped. */
export const COMEDIANS = [
  { key: 'aakash', name: 'Aakash', aliases: ['Aakash', 'Akaash'] },
  { key: 'abhay', name: 'Abhay', aliases: ['Abhay'] },
  { key: 'alberta', name: 'Alberta', aliases: ['Alberta', 'Albberta'] },
  { key: 'alex-kim', name: 'Alex Kim', aliases: ['Alex Kim', 'AlexK'] },
  { key: 'alex-shklar', name: 'Alex Shklar', aliases: ['Alex Shklar', 'Alex Shkar'] },
  { key: 'ali', name: 'Ali', aliases: ['Ali'] },
  { key: 'amanda-vasco', name: 'Amanda Vasco', aliases: ['Amanda', 'Amanda Vasco'] },
  { key: 'andrew-g', name: 'Andrew G.', aliases: ['AndrewG'] },
  { key: 'annette-mullaney', name: 'Annette Mullaney', aliases: ['Annette', 'Annette Mullaney'] },
  { key: 'ash', name: 'Ash', aliases: ['Ash'] },
  { key: 'austin-nasso', name: 'Austin Nasso', aliases: ['Austin', 'Austin Nasso'] },
  { key: 'ben', name: 'Ben', aliases: ['Ben'] },
  { key: 'betsy-carroll', name: 'Betsy Carroll', aliases: ['Betsy', 'Betsy Carroll'] },
  { key: 'bret-birnham', name: 'Bret Birnham', aliases: ['Bret Birnham'] },
  { key: 'brooke-heinichen', name: 'Brooke Heinichen', aliases: ['Brooke Heinichen', 'Brooke', 'Brook', 'BrookeN'] },
  { key: 'brooks-tawil', name: 'Brooks Tawil', aliases: ['Brooks Tawil', 'Brooks'] },
  { key: 'carlos', name: 'Carlos', aliases: ['Carlos'] },
  { key: 'christos', name: 'Christos', aliases: ['Christos'] },
  { key: 'daemin-lee', name: 'Daemin Lee', aliases: ['Daemin', 'Daemin Lee'] },
  { key: 'dan-guan', name: 'Dan Guan', aliases: ['Dan Guan'] },
  { key: 'dan-toomey', name: 'Dan Toomey', aliases: ['Dan Toomey', 'Dan T', 'Toomey'] },
  { key: 'dan-wickes', name: 'Dan Wickes', aliases: ['Dan Wickes'] },
  { key: 'david-s', name: 'David S.', aliases: ['DavidS'] },
  { key: 'denise-lee', name: 'Denise Lee', aliases: ['Denise', 'Denise Lee'] },
  { key: 'divya-gunasekaran', name: 'Divya Gunasekaran', aliases: ['Divya', 'DivyaG', 'Divya G', 'Divya Gunasekaran'] },
  { key: 'ed', name: 'Ed', aliases: ['Ed'] },
  { key: 'elisha', name: 'Elisha', aliases: ['Elisha'] },
  { key: 'hayden-arrington', name: 'Hayden Arrington', aliases: ['Hayden', 'HaydenA', 'Hayden Arrington'] },
  { key: 'humzah-choudry', name: 'Humzah Choudry', aliases: ['Humzah', 'Humzah C', 'Humzah Choudry'] },
  { key: 'ibhan', name: 'Ibhan', aliases: ['Ibhan'] },
  { key: 'irene', name: 'Irene', aliases: ['Irene'] },
  { key: 'james', name: 'James', aliases: ['James'] },
  { key: 'jesse-warren', name: 'Jesse Warren', aliases: ['Jesse', 'Jesse Warren'] },
  { key: 'k-cheng', name: 'K. Cheng', aliases: ['K Cheng', 'K. Cheng', 'KCheng'] },
  { key: 'karthik', name: 'Karthik', aliases: ['Karthik'] },
  { key: 'kaz-khadem', name: 'Kaz Khadem', aliases: ['Kaz', 'KazK', 'Kaz Khadem'] },
  { key: 'kilara', name: 'Kilara', aliases: ['Kilara'] },
  { key: 'kyle-lewis', name: 'Kyle Lewis', aliases: ['Kyle Lewis'] },
  // Neal says "Laxmi"; every file and sheet says Lakshmi. Both find her.
  { key: 'lakshmi-k', name: 'Lakshmi K', aliases: ['Lakshmi', 'Lakshmi K', 'Laxmi'] },
  { key: 'marcus-cusic', name: 'Marcus Cusic', aliases: ['Marcus Cusic'] },
  { key: 'nat-towsen', name: 'Nat Towsen', aliases: ['Nat', 'Nat Towsen'] },
  { key: 'nate-meeker', name: 'Nate Meeker', aliases: ['Nate', 'NateM', 'Nate Meeker'] },
  { key: 'naveed-mahbub', name: 'Naveed Mahbub', aliases: ['Naveed', 'Naveed Mahbub'] },
  // Host and performer. His hosting segments and split sets are parts (Neal2, NealPt2, Neal (Top),
  // Neal Additional …) and resolve here through the part-suffix rule rather than being listed.
  { key: 'neal-patel', name: 'Neal Patel', aliases: ['Neal', 'Neal P', 'NealP', 'Neal Patel', 'NealHostingSF'] },
  { key: 'nore-davis', name: 'Nore Davis', aliases: ['Nore Davis'] },
  // Every bare "Pete" so far is Ballmer (Neal, 2026-10-22), including PeteB and PeterB. "PeteSet"
  // is what performerFrom makes of March NYC's raw "PeteSet.mp4". "Pete Ballmer (LA)" and "Nat
  // Towsen (LA)" are request-sheet names, not tape labels, so they aren't listed.
  { key: 'pete-ballmer', name: 'Pete Ballmer', aliases: ['Pete', 'PeteB', 'PeterB', 'Pete Ballmer', 'PeteSet'] },
  { key: 'peter-liu', name: 'Peter Liu', aliases: ['PeterL', 'Peter Liu'] },
  { key: 'priya', name: 'Priya', aliases: ['Priya'] },
  { key: 'ryan-sudhakaran', name: 'Ryan Sudhakaran', aliases: ['Ryan Sudhakaran'] },
  { key: 'salma', name: 'Salma', aliases: ['Salma'] },
  { key: 'sam-frank', name: 'Sam Frank', aliases: ['Sam', 'Sam Frank'] },
  // Every Sarah so far is Sarah Barnitt (Neal, 2026-10-22).
  { key: 'sarah-barnitt', name: 'Sarah Barnitt', aliases: ['Sarah', 'SarahB', 'Sarah Barnitt'] },
  { key: 'sean', name: 'Sean', aliases: ['Sean'] },
  { key: 'shounak', name: 'Shounak', aliases: ['Shounak'] },
  { key: 'simren', name: 'Simren', aliases: ['Simren'] },
  { key: 'sonia-dennis', name: 'Sonia Dennis', aliases: ['Sonia Dennis'] },
  { key: 'srishti', name: 'Srishti', aliases: ['Srishti', 'Sristi', 'Sristhi'] },
  { key: 'stacy-cay', name: 'Stacy Cay', aliases: ['Stacy', 'Stacy Cay'] },
  { key: 'steven', name: 'Steven', aliases: ['Steven'] },
  { key: 'tariq', name: 'Tariq', aliases: ['Tariq'] },
  { key: 'tatiana-frank', name: 'Tatiana Frank', aliases: ['Tatiana', 'Tatiana Frank'] },
  { key: 'tirumari', name: 'Tirumari', aliases: ['Tirumari'] },
  { key: 'varun', name: 'Varun', aliases: ['Varun'] },
  // Every Victoria so far is Victoria Chuah (Neal, 2026-10-22).
  { key: 'victoria-chuah', name: 'Victoria Chuah', aliases: ['Victoria', 'Victoria Chuah'] },
  { key: 'vishal-kal', name: 'Vishal Kal', aliases: ['Vishal', 'Vishal Kal'] },
  { key: 'yanjaa-westgate', name: 'Yanjaa Westgate', aliases: ['Yanjaa', 'YanjaaW', 'Yanjaa Westgate'] },
  { key: 'yi', name: 'Yi', aliases: ['Yi'] },
  { key: 'zoe-dixon', name: 'Zoe Dixon', aliases: ['Zoe Dixon'] },
  { key: 'ziren', name: 'Ziren', aliases: ['Ziren'] },
]

/**
 * Labels that name more than one comedian. They resolve ONLY through SHOW_OVERRIDES — a new show's
 * bare "Dan Set.mp4" lands under "Unmatched tapes" until someone says which Dan, rather than being
 * filed under the wrong one.
 */
export const AMBIGUOUS = ['Dan', 'Alex', 'Peter']

/** Per show (keyed by the show folder name, e.g. "March 2026 (SF)"): tape label -> comedian key. */
export const SHOW_OVERRIDES = {
  // The ingest filed this show's tapes as "<Name>AUJun6FullSet Set.mp4". Which Alex, and who "Vick"
  // is, are still open — those two stay under Unmatched until Neal says.
  'June 2024 (NYC Tech Week)': {
    AliAUJun6FullSet: 'ali',
    AustinAUJun6FullSet: 'austin-nasso',
    HumzahAUJun6FullSet: 'humzah-choudry',
    LakshmiAUJun6FullSet: 'lakshmi-k',
    NealAUJun6AllHostingSets: 'neal-patel',
    VishalAUJun6FullSet: 'vishal-kal',
  },
  'July 2024 (NYC)': { Alex: 'alex-shklar' },
  'January 2025 (NYC)': { Dan: 'dan-toomey' },
  'June 2025 (NYC Tech Week)': { Dan: 'dan-toomey' },
  // The July 2025 "Doordash Set.mp4" is Aakash's set — his finished clip was cut from it.
  'July 2025 (NYC)': { Alex: 'alex-shklar', Doordash: 'aakash' },
  'December 2025 (NYC)': { Alex: 'alex-kim' },
  'February 2026 (NYC)': { Dan: 'dan-wickes', Peter: 'peter-liu' },
  'March 2026 (NYC)': { Dan: 'dan-wickes' },
  'March 2026 (SF)': { Dan: 'dan-guan' },
  // "S. Set.mp4" was renamed "Shounak Set.mp4" in Drive (Neal, 2026-10-22); the status file can
  // trail the rename. Per show only: as an alias, "S." would claim every "S", "S2" and "S (Top)".
  'April 2026 (NYC)': { 'S.': 'shounak' },
  'June 2026 (NYTW)': { Dan: 'dan-toomey' },
  'June 2026 (SF)': { Dan: 'dan-guan' },
}

/** Tape labels that aren't a person. Full-show tapes get split into sets later; until then, not listed. */
export const NOT_PEOPLE = ['Full Show', 'Sponsor Sketch']
