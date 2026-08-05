import os
import glob
import pandas as pd
from pathlib import Path
from typing import Dict, Any, List

class MCPDataServer:
    """
    Model Context Protocol (MCP) Data Server querying Olist E-Commerce dataset.
    Exposes structured, deterministic data tools for Customer, Order/Product, Payment, and Delivery Agents.
    """

    def __init__(self, data_dir: Path = None):
        if data_dir is None:
            from src.config import DATA_DIR
            self.data_dir = DATA_DIR
        else:
            self.data_dir = Path(data_dir)

        self._load_datasets()

    def _load_datasets(self):
        """Loads Olist CSV files into memory pandas DataFrames."""
        self.df_orders = self._read_csv("olist_orders_dataset.csv")
        self.df_customers = self._read_csv("olist_customers_dataset.csv")
        self.df_items = self._read_csv("olist_order_items_dataset.csv")
        self.df_payments = self._read_csv("olist_order_payments_dataset.csv")
        self.df_products = self._read_csv("olist_products_dataset.csv")
        self.df_sellers = self._read_csv("olist_sellers_dataset.csv")

    def _read_csv(self, filename: str) -> pd.DataFrame:
        path = self.data_dir / filename
        if path.exists():
            return pd.read_csv(path, dtype=str)
        return pd.DataFrame()

    def get_order(self, order_id: str) -> Dict[str, Any]:
        """MCP Tool: Query order header info by order_id."""
        if self.df_orders.empty:
            return {}
        rows = self.df_orders[self.df_orders["order_id"] == order_id]
        if rows.empty:
            return {}
        row = rows.iloc[0].to_dict()
        return {
            "order_id": row.get("order_id"),
            "customer_id": row.get("customer_id"),
            "order_status": row.get("order_status"),
            "order_purchase_timestamp": row.get("order_purchase_timestamp"),
            "order_approved_at": row.get("order_approved_at"),
            "order_delivered_carrier_date": row.get("order_delivered_carrier_date"),
            "order_delivered_customer_date": row.get("order_delivered_customer_date"),
            "order_estimated_delivery_date": row.get("order_estimated_delivery_date")
        }

    def get_order_by_id(self, order_id: str) -> Dict[str, Any]:
        return self.get_order(order_id)

    def get_customer_history(self, customer_id: str, claimed_order_id: str) -> Dict[str, Any]:
        """MCP Tool: Query customer identity and related order history."""
        if self.df_customers.empty or not customer_id:
            return {"customer_unique_id": None, "related_order_ids": []}

        # 1. Find customer_unique_id
        cust_rows = self.df_customers[self.df_customers["customer_id"] == customer_id]
        if cust_rows.empty:
            return {"customer_unique_id": None, "related_order_ids": []}

        customer_unique_id = cust_rows.iloc[0]["customer_unique_id"]

        # 2. Find all customer_ids sharing the same customer_unique_id
        all_cust_ids = self.df_customers[
            self.df_customers["customer_unique_id"] == customer_unique_id
        ]["customer_id"].tolist()

        # 3. Find all orders for these customer_ids
        order_rows = self.df_orders[self.df_orders["customer_id"].isin(all_cust_ids)]
        all_order_ids = order_rows["order_id"].tolist()

        # 4. Filter out claimed_order_id for related_order_ids (stable order, max 5)
        related_order_ids = [oid for oid in all_order_ids if oid != claimed_order_id]

        return {
            "customer_unique_id": customer_unique_id,
            "related_order_ids": related_order_ids[:5]
        }

    def get_order_items_and_products(self, order_id: str) -> Dict[str, Any]:
        """MCP Tool: Retrieve order items, products, sellers, and original Portuguese product categories."""
        if self.df_items.empty:
            return {
                "item_ids": [],
                "seller_ids": [],
                "product_ids": [],
                "category_names": [],
                "item_total_brl": None,
                "freight_total_brl": None,
                "items_detail": []
            }

        items_rows = self.df_items[self.df_items["order_id"] == order_id]
        if items_rows.empty:
            return {
                "item_ids": [],
                "seller_ids": [],
                "product_ids": [],
                "category_names": [],
                "item_total_brl": None,
                "freight_total_brl": None,
                "items_detail": []
            }

        item_ids = []
        seller_ids = []
        product_ids = []
        category_names = []
        item_total_brl = 0.0
        freight_total_brl = 0.0
        items_detail = []

        for _, row in items_rows.iterrows():
            item_seq = str(row.get("order_item_id", "")).strip()
            item_id = f"{order_id}:{item_seq}"
            item_ids.append(item_id)

            seller_id = str(row.get("seller_id", "")).strip()
            if seller_id and seller_id not in seller_ids:
                seller_ids.append(seller_id)

            product_id = str(row.get("product_id", "")).strip()
            if product_id and product_id not in product_ids:
                product_ids.append(product_id)

            # Category lookup (Strictly keep original Portuguese category_name per EC_001 gold reference)
            category_name = None
            if not self.df_products.empty and product_id:
                p_rows = self.df_products[self.df_products["product_id"] == product_id]
                if not p_rows.empty:
                    cat_pt = str(p_rows.iloc[0].get("product_category_name", "")).strip()
                    if cat_pt and cat_pt != "nan":
                        category_name = cat_pt

            if category_name and category_name not in category_names:
                category_names.append(category_name)

            price = float(row.get("price", 0.0))
            freight = float(row.get("freight_value", 0.0))
            item_total_brl += price
            freight_total_brl += freight

            shipping_limit = str(row.get("shipping_limit_date", "")).strip()

            items_detail.append({
                "order_item_id": item_seq,
                "item_id": item_id,
                "product_id": product_id,
                "seller_id": seller_id,
                "category_name": category_name,
                "shipping_limit_at": shipping_limit,
                "price": price,
                "freight_value": freight
            })

        return {
            "item_ids": item_ids[:5],
            "seller_ids": seller_ids[:3],
            "product_ids": product_ids[:5],
            "category_names": category_names[:5],
            "item_total_brl": round(item_total_brl, 2),
            "freight_total_brl": round(freight_total_brl, 2),
            "items_detail": items_detail
        }

    def get_order_payments(self, order_id: str) -> Dict[str, Any]:
        """MCP Tool: Query order payment rows and reconcile totals."""
        if self.df_payments.empty:
            return {
                "currency": "BRL",
                "payment_ids": [],
                "payment_types": [],
                "payment_total_brl": 0.0
            }

        pay_rows = self.df_payments[self.df_payments["order_id"] == order_id]
        if pay_rows.empty:
            return {
                "currency": "BRL",
                "payment_ids": [],
                "payment_types": [],
                "payment_total_brl": 0.0
            }

        payment_ids = []
        payment_types = []
        payment_total = 0.0

        for _, row in pay_rows.iterrows():
            pay_seq = str(row.get("payment_sequential", "")).strip()
            payment_id = f"{order_id}:{pay_seq}"
            payment_ids.append(payment_id)

            ptype = str(row.get("payment_type", "")).strip()
            if ptype and ptype not in payment_types:
                payment_types.append(ptype)

            pval = float(row.get("payment_value", 0.0))
            payment_total += pval

        return {
            "currency": "BRL",
            "payment_ids": payment_ids[:5],
            "payment_types": payment_types,
            "payment_total_brl": round(payment_total, 2)
        }
