import { render } from "@solidjs/web";
import "@fontsource-variable/inter";
import "@fontsource/sansita/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import { Factory } from "./factory";
import "./tokens.css";
import "./knowledge-workspace.css";
import "./runtime-workspace.css";
import "./style.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Factory root element is missing");
render(() => <Factory />, root);
