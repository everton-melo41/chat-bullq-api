declare module 'pdf-parse/lib/pdf-parse.js' {
  function parse(data: Buffer): Promise<{ text: string }>;
  export = parse;
}
