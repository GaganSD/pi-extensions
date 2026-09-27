export const WORKING_WORDS = [
  "Crafting",
  "Mining",
  "Farming",
  "Building",
  "Pondering",
  "Yeeting",
  "Manifesting",
  "Transmuting",
] as const;

export function createWordPicker() {
  let bag: string[] = [];
  let last: string | undefined;

  return {
    next(): string {
      if (bag.length === 0) {
        bag = WORKING_WORDS.slice();
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [bag[i], bag[j]] = [bag[j]!, bag[i]!];
        }
        if (bag.length > 1 && bag[bag.length - 1] === last) {
          [bag[bag.length - 1], bag[0]] = [bag[0]!, bag[bag.length - 1]!];
        }
      }
      last = bag.pop()!;
      return last;
    },
  };
}
