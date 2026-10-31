import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { visualizer } from "rollup-plugin-visualizer";
import { compression } from "vite-plugin-compression2";
import postCssScss from "postcss-scss";
import postcssRTLCSS from "postcss-rtlcss";
export default defineConfig({
    server: { port: 3000 },
    define: { FRONTEND_VERSION: JSON.stringify(process.env.npm_package_version), "process.env": {} },
    plugins: [
        vue(),
        visualizer({ filename: "tmp/dist-stats.html" }),
        compression({
            algorithms: ["gzip", "brotliCompress"],
            include: /\.(js|mjs|json|css|html|svg)$/i,
            threshold: 1025,
        }),
    ],
    css: { postcss: { parser: postCssScss, map: false, plugins: [postcssRTLCSS] } },
});
