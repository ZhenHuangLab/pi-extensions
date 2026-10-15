import { loadInstance, createRender } from "libtexprintf";
import { transformMarkdown, replaceStackedSums } from "./transform.ts";

const instance = await loadInstance();
const render = createRender(instance);
function typeset(tex) {
  const { output, errors } = render(tex);
  if (errors.length) { console.log("ERR", tex, errors); return null; }
  return output;
}
const opts = { availableWidth: 100, measureWidth: (s) => s.length, typeset };

const cases = [
  String.raw`\hat{f} = \frac{\sum_{ij} w_{ij}\,\gamma_{ij}}{\sum_{ij} w_{ij}}`,
  String.raw`\mathcal{L} = \sum_{i<j} \left[ \log(1-\rho^2) + \frac{|x_i|^2 - 2\rho\,\mathrm{Re}(x_i \bar{x}_j)}{1-\rho^2} \right]`,
  String.raw`\rho_{ij}(q) = f \cdot m_{ij}(q)\, e^{-i\varphi_{ij}(q)}`,
];
for (const tex of cases) {
  const raw = typeset(tex);
  console.log("===== RAW =====\n" + raw);
  console.log("===== FIXED =====\n" + replaceStackedSums(raw));
  console.log("===== MD =====\n" + transformMarkdown("$$\n"+tex+"\n$$", opts));
}
