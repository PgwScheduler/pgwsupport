export const DENOMS = [
  ["pennies", "Pennies", 0.01], ["nickels", "Nickels", 0.05], ["dimes", "Dimes", 0.10], ["quarters", "Quarters", 0.25],
  ["ones", "Ones", 1], ["twos", "Twos", 2], ["fives", "Fives", 5], ["tens", "Tens", 10],
  ["twenties", "Twenties", 20], ["fifties", "Fifties", 50], ["hundreds", "Hundreds", 100],
];
export const COINS = DENOMS.slice(0, 4);
export const BILLS = DENOMS.slice(4);

export const num = (v) => Number(v) || 0;
export const countTotal = (q) => DENOMS.reduce((a, [k, , d]) => a + num(q?.[k]) * d, 0);
