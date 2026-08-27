import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // ExcelJS (~1 MB minified) is only ever reached through the three
        // workbook modules, each of which is import()ed at click time
        // (ScheduleView.jsx, useCloseoutRangeExport.js, useReportBuilder.js).
        // Pinning it to its own chunk keeps that one copy out of the entry and
        // out of all three workbook chunks, so it is fetched the first time
        // someone exports anything and then cached for the other two.
        //
        // The dynamic imports are what keep it off first paint; this rule only
        // decides which file it lands in. Add a static import of any workbook
        // module and ExcelJS is back in the entry chunk regardless of this.
        manualChunks(id) {
          // Rollup's CommonJS interop helpers are a virtual module shared by
          // every CJS dependency. Unassigned, they get folded into the ExcelJS
          // chunk, and then the entry — which needs them for its own CJS deps —
          // statically imports that chunk and ExcelJS is preloaded on first
          // paint again, even though nothing in the entry touches ExcelJS.
          // Giving them a chunk of their own keeps that edge tiny.
          if (id.includes("commonjsHelpers")) return "cjs-helpers";
          if (id.includes("node_modules/exceljs/")) return "exceljs";
        },
      },
    },
  },
});
