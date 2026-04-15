import createPurify from "dompurify";
import hljs from "highlight.js";
import { marked } from "marked";

// Setup global window objects for the browser environment
window.marked = marked;
window.DOMPurify = createPurify(window);
window.hljs = hljs;
