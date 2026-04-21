import { ParserRegistry } from "./parserRegistry.js";
import { JavaScriptParser } from "./parsers/javascriptParser.js";
import { TypeScriptParser } from "./parsers/typescriptParser.js";
import { TypeScriptXParser } from "./parsers/typescriptXParser.js";
import { PythonParser } from "./parsers/pythonParser.js";

export const registry = new ParserRegistry();

registry.register(new JavaScriptParser());
registry.register(new TypeScriptParser());
registry.register(new TypeScriptXParser());
registry.register(new PythonParser());
