declare module "xml-formatter" {
  export = index;
  interface Options {
    collapseContent?: boolean;
    stripComments?: boolean;
  }
  declare function index(xml: string, options?: Options): any;
}
