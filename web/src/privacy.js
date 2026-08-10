import { createSSRApp } from "vue";
import "./styles/main.css";
import PrivacyPage from "./pages/PrivacyPage.vue";

// createSSRApp (not createApp) so this HYDRATES the markup that
// scripts/prerender.mjs baked into the HTML, rather than throwing it away and
// re-rendering. That prerendered markup is what a visitor sees if this script
// never runs at all.
createSSRApp(PrivacyPage).mount("#app");
