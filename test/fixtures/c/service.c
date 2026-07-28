#include "service.h"

int helper(int value) {
    return value + 1;
}

int run_service(int value) {
    Service service = { 2 };
    return helper(value) * service.factor;
}
