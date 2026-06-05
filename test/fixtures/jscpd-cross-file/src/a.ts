export function summarizeOrders(orders: Array<{ total: number; status: string }>) {
  const openOrders = orders.filter((order) => order.status === "open");
  const total = openOrders.reduce((sum, order) => sum + order.total, 0);
  const count = openOrders.length;
  return { total, count };
}
