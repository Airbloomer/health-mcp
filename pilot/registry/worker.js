/** Registry stub. It does not read secrets and it is not deployed by P1. */
export default {
  async fetch() {
    return new Response("not found", { status: 404 });
  },
};
