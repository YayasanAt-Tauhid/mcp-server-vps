// Serialisasi hasil tool untuk model: JSON ringkas (tanpa indentasi) agar hemat token.
// Jangan dipakai untuk file state/registry yang dibaca manusia (itu tetap berindentasi).
export function toolJson(value) {
  try {
    const out = JSON.stringify(value);
    return out === undefined ? 'null' : out;
  } catch {
    return String(value);
  }
}
