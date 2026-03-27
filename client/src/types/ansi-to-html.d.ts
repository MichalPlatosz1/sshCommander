declare module "ansi-to-html" {
  type ConstructorOptions = {
    fg?: string;
    bg?: string;
    newline?: boolean;
    escapeXML?: boolean;
    stream?: boolean;
  };

  export default class AnsiToHtml {
    constructor(options?: ConstructorOptions);
    toHtml(input: string): string;
  }
}
