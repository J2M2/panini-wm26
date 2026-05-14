import { getLocale } from "./i18n";
import { initApp } from "./app";

document.documentElement.lang = getLocale() === "es" ? "es" : "en";

const root = document.getElementById("app");
if (root) initApp(root);
