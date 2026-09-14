'''
- Gồm có 1 chuỗi các node được liên kết nhau bởi 1 con trỏ
- Được phân bố bởi các bộ nhớ không liền kề nhau

- Cấu trúc từ node -> node khác gọi là self-reference
- Structure gồm: Data và Pointer
'''
class Node():
    def __init__(self, data):
        self.data = data
        self.next = None #pointer
        
class SimplyLinkedList():
    def __init__(self):
        self.head = None
        self.tail = None
        
    def isEmpty(self) -> bool:
        return self.head is None
    
    def insertLast(self, number):
        newNode = Node(number)
        if self.isEmpty():
            self.head = self.tail = newNode
        else:
            self.tail.next = newNode
            self.tail = newNode
            

    def insertFirst(self, number):
        newNode = Node(number)
        if self.isEmpty():
            self.head = self.tail = newNode
        else:
            newNode.next = self.head
            self.head = newNode
        
    def removeFirst(self) -> Node:
        if self.isEmpty():
            print("Empty")
            return None
        
        remove_node = self.head
        self.head = self.head.next
        self.head.next = self.head
        return remove_node

    def removeLast(self) -> Node:
        if self.isEmpty():
            print("Empty")
            return None
        
        current_node = self.head
        
        while current_node.next != self.tail:
            current_node = current_node.next
            
        self.tail = current_node
        self.tail.next = None
    
    def removeIndex(self, index):
        if self.isEmpty():
            print("Empty")
            return none
        elif index == 0:
            remove_node = self.head
            self.removeFirst()
            return remove_node

        current_node = self.head    
        for i in range(index-1):
            current_node = current_node.next
        
        remove_node = current_node.next
        current_node.next = remove_node.next
        self.tail = current_node
                
        return remove_node


    def display(self):
        if self.isEmpty():
            print("List is empty")
            return
        else:
            print("From Head to Tail:")
            node = self.head
            while node is not None:
                print(node.data, end = "  ")
                node = node.next
            print("\n--END--\n")

if __name__== "__main__":

    call = SimplyLinkedList()

    call.insertLast(0)
    call.insertLast(1)
    call.insertLast(2)
    call.insertLast(3)
    call.insertLast(4)
    call.insertLast(5)
    call.removeIndex(5)
    call.removeLast()
    call.removeLast()
    call.insertLast(6)
    call.display()
    



