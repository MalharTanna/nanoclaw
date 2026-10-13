/**
 * A message that only says thanks ("thanks Miro", "dhanyavad 🙏", "👍") needs
 * no answer. On shared (Miroflow) installs the router reacts with 🙏 instead
 * of starting an AI run. Words like "ok" or "yes" are NOT here: they are often
 * answers to a question the assistant just asked.
 */
const THANKS_WORDS = new Set([
  'thanks', 'thank', 'thanku', 'thankyou', 'thx', 'thnx', 'thnks', 'tnx', 'ty', 'tq', 'tqsm', 'tysm',
  'dhanyavad', 'dhanyawad', 'dhanyavaad', 'dhanyawaad', 'aabhar', 'abhar', 'aabhaar', 'shukriya', 'shukria',
  'dhanyabad', 'nandri', 'nanri', 'dhanyavadalu', 'dhanyavadagalu',
  'धन्यवाद', 'શુક્રિયા', 'આભાર', 'ધન્યવાદ', 'शुक्रिया', 'आभार', 'धन्यवादम्',
]);
const FILLER = new Set([
  'you', 'u', 'so', 'very', 'much', 'a', 'lot', 'lots', 'many', 'again', 'for', 'the', 'help', 'it', 'that',
  'miro', 'bhai', 'ji', 'sir', 'madam', 'maam', 'dear', 'buddy', 'bro', 'great', 'nice', 'super', 'awesome',
  'perfect', 'good', 'job', 'work', 'done', 'well', 'helpful', 'hu', 'che', 'hai', 'bahut', 'khub', 'saru',
]);
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s]+$/u;
const THANKS_EMOJI = /[🙏👍❤️♥😊🙂👌💯🤝✅😀😃😄😁🥰💐]/u;

export function isPureThanks(text: string): boolean {
  const t = text.replace(/@\S+/g, ' ').trim();
  if (!t || t.length > 80) return false;
  if (EMOJI_ONLY.test(t)) return THANKS_EMOJI.test(t);
  const words = t
    .toLowerCase()
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]/gu, ' ')
    .replace(/[.,!?;:'"()\-_*~]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return THANKS_EMOJI.test(t);
  let thanked = false;
  for (const w of words) {
    if (THANKS_WORDS.has(w)) thanked = true;
    else if (!FILLER.has(w)) return false;
  }
  return thanked;
}
