import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: { extend: { colors: {
    navy: "#14213d", gold: "#fca311",
    pass: "#1a7431", review: "#e0a800", fail: "#9d0208", strblue: "#1d4ed8",
  } } },
  plugins: [],
};
export default config;
