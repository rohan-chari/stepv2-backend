import { createSSRApp } from "vue";
import "./styles/main.css";
import BillingTermsPage from "./pages/BillingTermsPage.vue";

createSSRApp(BillingTermsPage).mount("#app");
