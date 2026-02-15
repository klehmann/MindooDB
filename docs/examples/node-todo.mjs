import {
  BaseMindooTenantFactory,
  InMemoryContentAddressedStoreFactory,
  KeyBag,
} from "mindoodb";

async function main() {
  const storeFactory = new InMemoryContentAddressedStoreFactory();
  const factory = new BaseMindooTenantFactory(storeFactory);

  const user = await factory.createUserId("CN=node-todo-user/O=demo", "user-password");
  const adminUser = await factory.createUserId("CN=admin/O=demo", "admin-password");
  const keyBag = new KeyBag(user.userEncryptionKeyPair.privateKey, "user-password");

  const tenant = await factory.openTenant(
    "node-todo-tenant",
    adminUser.userSigningKeyPair.publicKey,
    adminUser.userEncryptionKeyPair.publicKey,
    user,
    "user-password",
    keyBag
  );

  const db = await tenant.openDB("todos");

  const todo = await db.createDocument();
  await db.changeDoc(todo, async (d) => {
    const data = d.getData();
    data.title = "Buy milk";
    data.done = false;
  });

  const todoIds = await db.getAllDocumentIds();
  const loadedTodo = await db.getDocument(todoIds[0]);
  console.log("Loaded todo:", loadedTodo.getData());
}

main().catch((err) => {
  console.error("Example failed:", err);
  process.exit(1);
});
