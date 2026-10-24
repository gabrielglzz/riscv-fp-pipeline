# Pipeline FP RISC-V

[![CI and deployment](https://github.com/gabrielglzz/riscv-fp-pipeline/actions/workflows/ci.yml/badge.svg)](https://github.com/gabrielglzz/riscv-fp-pipeline/actions/workflows/ci.yml)

Web simulator of an **in-order 5-stage RISC-V pipeline with multicycle floating-point units**, built to teach static instruction scheduling. It follows the Chapter 3 and Appendix C models of *Computer Architecture: A Quantitative Approach* (Hennessy and Patterson, 7th edition).

**Try it:** https://gabrielglzz.github.io/riscv-fp-pipeline/

*[Resumen en castellano al final](#resumen-en-castellano)*

---

## Features

- **RISC-V assembly editor** (RV64I + M + F + D, with pseudo-instructions and data directives).
- **Cycle diagram** with stalls coloured by cause (RAW, structural, WAW, control). Hover over a stall to see why it happens.
- **Cycle-by-cycle mode** showing the state of every stage and functional unit, what happens in each cycle, and the registers and memory at that point.
- **Configurable processor**: timing model, forwarding, branch handling, branch resolution stage, and the cycles and pipelining of each FP unit.
- **Classroom examples**: RAW, structural and WAW hazards; the `x[i] = x[i] + s` loop in its original, scheduled, unrolled and software-pipelined versions; a delayed branch; and independent divisions.
- **Baseline comparison** showing cycles and speedup.
- **Spanish and English** interface, light and dark themes, and phone support.
- **A single `index.html` file** with no dependencies. It works offline and can be uploaded to any platform.

## Model

| Option | Values | Default |
|---|---|---|
| Timing model | Chapter 3 latencies · Detailed Appendix C | Chapter 3 |
| Result forwarding | on / off | on |
| Branch handling | Predict not taken · Freeze the pipeline · Delayed branch (teaching mode) | Predict not taken |
| Branch resolution | EX (7th ed., RISC-V) · ID (MIPS editions) | EX |
| EX cycles (adder / multiplier / divider) | 1–60 | 4 / 7 / 25 |
| Pipelined units | adder / multiplier / divider | yes / yes / no |

- **Chapter 3**: latencies FP→FP 3, FP→store 2, load→FP 1, load→store 0. MEM/WB conflicts are not modelled.
- **Appendix C**: FP operations also occupy MEM and WB, which causes write-port conflicts and WAW stalls, and stores wait for their data in EX.
- **EX cycles** are the cycles an operation spends in its unit. The textbook *latency* is one less: the adder has 4 cycles (latency 3), the multiplier 7 (latency 6) and the divider 25 (latency 24, with an initiation interval of 25 when not pipelined).
- **Branches in EX** read their registers like any other instruction, but a taken branch costs 2 cycles. **Branches in ID** cost only 1 cycle, but need their registers earlier: 1 stall after an integer operation and 2 after a load.
- **RISC-V has no delayed branches.** That mode is a teaching aid with MIPS semantics.
- The textbook does not count the taken-branch penalty, but the simulator does. With branches in EX, the Chapter 3 loops therefore take 2 more cycles per iteration than in the book (8 → 10, 7 → 9, 26 → 28, 14 → 16).

### Supported instructions

- Integer: `add sub and or xor slt sltu sll srl sra mul div rem`, their immediate forms, `lui`, `li`, `la`, `mv`, `nop`.
- Memory: `lw ld sw sd flw fld fsw fsd`.
- Control: `beq bne blt bge bltu bgeu`, `beqz bnez bgt ble…`, `j jal jr ret`; `ecall` stops the simulation.
- Floating point (`.d` and `.s`): `fadd fsub fmul fdiv fsqrt fmin fmax fmv fneg fabs feq flt fle fcvt`.
- Directives: `.data .text .double .float .dword .word .space .align`.

**Not supported:** byte and half-word accesses, RV64 `*w` operations, `fmadd`/`fmsub`, the stack and full function calls, and the C, A and V extensions.

## Tests

```bash
npm ci
npm run test:engine     # engine: Node 22 or later, no browser needed
npx playwright install chromium
npm run test:ui         # interface, in Chromium
```

- **Engine** (`tests/engine`):
  - pipeline invariants on every example and on seeded random programs, across 216 configurations: stage order, RAW and WAW hazards, MEM/WB and unit occupancy, stall accounting, and consistency of the diagram and the cycle-by-cycle view;
  - final registers and memory compared with an independent reference interpreter;
  - regressions against the textbook results;
  - assembler error messages and edge cases;
  - complete translations.

  `FUZZ_N` and `FUZZ_SEED` set how many random programs are generated and with which seed. `SIM_HTML` points the tests at another copy of the simulator.
- **Interface** (`tests/ui`, Playwright): every example, mode, tab and language without errors or untranslated text, plus the cycle-by-cycle mode, error display, baseline, phone layout and dark theme.

The workflow in `.github/workflows/ci.yml` runs both suites on every push and pull request. When they pass on `main`, it publishes the simulator to GitHub Pages.


## License

[MIT](LICENSE).

---

<a id="resumen-en-castellano"></a>
## Resumen en castellano

Simulador web de un **pipeline RISC-V de 5 etapas en orden con unidades de coma flotante multiciclo**, pensado para enseñar planificación estática de instrucciones. Sigue los modelos del capítulo 3 y del apéndice C de *Computer Architecture: A Quantitative Approach* (Hennessy y Patterson, 7.ª edición).

- **Qué ofrece**:
  - editor de ensamblador RISC-V (RV64IMFD);
  - diagrama de ciclos con las paradas coloreadas por su causa;
  - modo ciclo a ciclo;
  - configuración del modelo de temporización, el adelantamiento, el tratamiento de saltos y la etapa en que se resuelven, y los ciclos y la segmentación de cada unidad FP;
  - ejemplos para clase, comparación con una versión de referencia, interfaz en español e inglés, tema claro y oscuro, y uso en el móvil.
- **Un único fichero** `index.html`, sin dependencias, que funciona sin conexión.
- **Notas del modelo**:
  - Los *ciclos en EX* son los que la operación pasa en su unidad; la *latencia* del libro es uno menos (4/7/25 ciclos → latencia 3/6/24).
  - Con los saltos resueltos en EX, un salto tomado cuesta 2 ciclos. El libro no cuenta esa penalización, así que los bucles salen con 2 ciclos más por iteración.
  - RISC-V no tiene salto retardado: ese modo es didáctico y sigue la semántica de MIPS.
- **Pruebas**: `npm run test:engine` comprueba los invariantes del pipeline, compara los resultados con un intérprete de referencia, contrasta las cifras del libro, los errores del ensamblador y las traducciones. `npm run test:ui` ejecuta las pruebas de Playwright en Chromium. GitHub Actions pasa ambas y publica en GitHub Pages desde `main`.
- **Publicación**: en *Settings → Pages → Source*, elegir *GitHub Actions* y hacer `push` a `main`. Al ser un sitio de proyecto, no interfiere con la web personal de `gabrielglzz.github.io`.
- **Licencia**: MIT.
---
## Acknowledgements

Developed by gabrielglzz with the assistance of Claude (Anthropic). The timing
model was checked against *Computer Architecture: A Quantitative Approach*
(7th edition), and every change is validated by the automated test suite.